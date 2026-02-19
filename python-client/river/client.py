"""River client for invoking remote procedures.

Provides the high-level API for calling rpc, stream, upload, and
subscription procedures on a River server.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Callable

from river.streams import Readable, Writable
from river.transport import WebSocketClientTransport
from river.types import (
    ControlFlags,
    PartialTransportMessage,
    TransportMessage,
    cancel_message,
    close_stream_message,
    err_result,
    generate_id,
    is_ack,
    is_stream_cancel,
    is_stream_close,
    CANCEL_CODE,
    UNEXPECTED_DISCONNECT_CODE,
)

logger = logging.getLogger(__name__)


@dataclass
class RpcResult:
    """Result of an RPC call."""

    ok: bool
    payload: Any


@dataclass
class StreamResult:
    """Result of opening a stream procedure."""

    req_writable: Writable
    res_readable: Readable


@dataclass
class UploadResult:
    """Result of opening an upload procedure."""

    req_writable: Writable
    finalize: Callable[[], Any]  # async callable returning RpcResult


@dataclass
class SubscriptionResult:
    """Result of opening a subscription procedure."""

    res_readable: Readable


class RiverClient:
    """Client for invoking procedures on a River server.

    Usage:
        transport = WebSocketClientTransport("ws://localhost:8080", ...)
        client = RiverClient(transport, server_id="my-server")

        # RPC
        result = await client.rpc("service", "procedure", {"arg": 1})

        # Stream
        stream = client.stream("service", "procedure", {"arg": 1})
        stream.req_writable.write({"data": "hello"})
        async for msg in stream.res_readable:
            print(msg)

        # Upload
        upload = client.upload("service", "procedure", {"arg": 1})
        upload.req_writable.write({"data": "chunk1"})
        upload.req_writable.close()
        result = await upload.finalize()

        # Subscription
        sub = client.subscribe("service", "procedure", {"arg": 1})
        async for msg in sub.res_readable:
            print(msg)
    """

    def __init__(
        self,
        transport: WebSocketClientTransport,
        server_id: str | None = None,
        connect_on_invoke: bool = True,
        eagerly_connect: bool = False,
    ) -> None:
        self._transport = transport
        self._server_id = server_id or transport.server_id
        self._connect_on_invoke = connect_on_invoke

        if eagerly_connect:
            transport.connect(self._server_id)

    @property
    def transport(self) -> WebSocketClientTransport:
        return self._transport

    async def rpc(
        self,
        service_name: str,
        procedure_name: str,
        init: Any,
        abort_signal: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        """Invoke an RPC procedure.

        Returns the result dict: {"ok": True/False, "payload": ...}
        """
        result = self._handle_proc(
            proc_type="rpc",
            service_name=service_name,
            procedure_name=procedure_name,
            init=init,
            abort_signal=abort_signal,
        )
        # For RPC, we await the single response
        readable = result["res_readable"]
        done, value = await readable.next()
        if done:
            return err_result(
                UNEXPECTED_DISCONNECT_CODE, "No response received"
            )
        return value

    def stream(
        self,
        service_name: str,
        procedure_name: str,
        init: Any,
        abort_signal: asyncio.Event | None = None,
    ) -> StreamResult:
        """Open a stream procedure.

        Returns StreamResult with req_writable and res_readable.
        """
        result = self._handle_proc(
            proc_type="stream",
            service_name=service_name,
            procedure_name=procedure_name,
            init=init,
            abort_signal=abort_signal,
        )
        return StreamResult(
            req_writable=result["req_writable"],
            res_readable=result["res_readable"],
        )

    def upload(
        self,
        service_name: str,
        procedure_name: str,
        init: Any,
        abort_signal: asyncio.Event | None = None,
    ) -> UploadResult:
        """Open an upload procedure.

        Returns UploadResult with req_writable and finalize().
        """
        result = self._handle_proc(
            proc_type="upload",
            service_name=service_name,
            procedure_name=procedure_name,
            init=init,
            abort_signal=abort_signal,
        )

        async def finalize() -> dict[str, Any]:
            readable = result["res_readable"]
            done, value = await readable.next()
            if done:
                return err_result(
                    UNEXPECTED_DISCONNECT_CODE, "No response received"
                )
            return value

        return UploadResult(
            req_writable=result["req_writable"],
            finalize=finalize,
        )

    def subscribe(
        self,
        service_name: str,
        procedure_name: str,
        init: Any,
        abort_signal: asyncio.Event | None = None,
    ) -> SubscriptionResult:
        """Open a subscription procedure.

        Returns SubscriptionResult with res_readable.
        """
        result = self._handle_proc(
            proc_type="subscription",
            service_name=service_name,
            procedure_name=procedure_name,
            init=init,
            abort_signal=abort_signal,
        )
        return SubscriptionResult(res_readable=result["res_readable"])

    def _handle_proc(
        self,
        proc_type: str,
        service_name: str,
        procedure_name: str,
        init: Any,
        abort_signal: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        """Core procedure dispatch logic.

        Sets up the stream, registers message handlers, sends the init message.
        """
        to = self._server_id
        transport = self._transport

        # If transport is closed, return immediate disconnect error
        if transport.get_status() != "open":
            res_readable = Readable()
            res_readable._push_value(
                err_result(
                    UNEXPECTED_DISCONNECT_CODE, "transport is closed"
                )
            )
            res_readable._trigger_close()
            req_writable = Writable(write_cb=lambda _: None, close_cb=None)
            req_writable._closed = True
            return {
                "res_readable": res_readable,
                "req_writable": req_writable,
            }

        # Connect if needed
        if self._connect_on_invoke:
            transport.connect(to)

        # Get the session and a send function
        session = transport._get_or_create_session(to)
        session_id = session.id
        try:
            send_fn = transport.get_session_bound_send_fn(to, session_id)
        except RuntimeError:
            # Session already dead
            res_readable = Readable()
            res_readable._push_value(
                err_result(
                    UNEXPECTED_DISCONNECT_CODE,
                    f"{to} unexpectedly disconnected",
                )
            )
            res_readable._trigger_close()
            req_writable = Writable(write_cb=lambda _: None, close_cb=None)
            req_writable._closed = True
            return {
                "res_readable": res_readable,
                "req_writable": req_writable,
            }

        # Determine flags
        proc_closes_with_init = proc_type in ("rpc", "subscription")
        stream_id = generate_id()

        # Create readable for responses
        res_readable: Readable = Readable()

        # Tracking state
        clean_close = True
        cleaned_up = False

        def cleanup():
            nonlocal cleaned_up
            if cleaned_up:
                return
            cleaned_up = True
            transport.remove_event_listener("message", on_message)
            transport.remove_event_listener("sessionStatus", on_session_status)

        def close_readable():
            if not res_readable.is_closed():
                try:
                    res_readable._trigger_close()
                except RuntimeError:
                    pass
            if req_writable.is_closed():
                cleanup()

        # Create writable for requests
        def write_cb(raw_value: Any) -> None:
            try:
                send_fn(
                    PartialTransportMessage(
                        payload=raw_value,
                        stream_id=stream_id,
                        control_flags=0,
                    )
                )
            except RuntimeError:
                pass

        def close_cb() -> None:
            nonlocal clean_close
            if not proc_closes_with_init and clean_close:
                try:
                    send_fn(close_stream_message(stream_id))
                except RuntimeError:
                    pass
            if res_readable.is_closed():
                cleanup()

        req_writable: Writable = Writable(write_cb=write_cb, close_cb=close_cb)

        def on_message(msg: TransportMessage) -> None:
            nonlocal clean_close
            if msg.stream_id != stream_id:
                return
            if msg.to != transport.client_id:
                return

            # Cancel from server
            if is_stream_cancel(msg.control_flags):
                clean_close = False
                payload = msg.payload
                if isinstance(payload, dict) and "ok" in payload:
                    res_readable._push_value(payload)
                else:
                    res_readable._push_value(
                        err_result(
                            payload.get("code", "UNKNOWN") if isinstance(payload, dict) else "UNKNOWN",
                            str(payload),
                        )
                    )
                close_readable()
                if req_writable.is_writable():
                    req_writable._closed = True
                return

            if res_readable.is_closed():
                return

            # Normal payload (not a CLOSE control)
            if isinstance(msg.payload, dict):
                if msg.payload.get("type") != "CLOSE":
                    if "ok" in msg.payload:
                        res_readable._push_value(msg.payload)

            # Stream close
            if is_stream_close(msg.control_flags):
                close_readable()

        def on_session_status(evt: dict) -> None:
            nonlocal clean_close
            if evt.get("status") != "closing":
                return
            event_session = evt.get("session")
            if event_session is None:
                return
            if event_session.to_id != to or event_session.id != session_id:
                return

            clean_close = False
            try:
                res_readable._push_value(
                    err_result(
                        UNEXPECTED_DISCONNECT_CODE,
                        f"{to} unexpectedly disconnected",
                    )
                )
            except RuntimeError:
                pass
            close_readable()
            if req_writable.is_writable():
                req_writable._closed = True

        def on_client_cancel() -> None:
            nonlocal clean_close
            clean_close = False
            try:
                res_readable._push_value(
                    err_result(CANCEL_CODE, "cancelled by client")
                )
            except RuntimeError:
                pass
            close_readable()
            if req_writable.is_writable():
                req_writable._closed = True
            try:
                send_fn(
                    cancel_message(
                        stream_id,
                        err_result(CANCEL_CODE, "cancelled by client"),
                    )
                )
            except RuntimeError:
                pass

        # Register listeners
        transport.add_event_listener("message", on_message)
        transport.add_event_listener("sessionStatus", on_session_status)

        # Wire up abort signal
        if abort_signal is not None:
            # Use asyncio task to watch the event
            async def _watch_abort():
                await abort_signal.wait()
                on_client_cancel()

            try:
                loop = asyncio.get_event_loop()
                loop.create_task(_watch_abort())
            except RuntimeError:
                pass

        # Send init message
        init_flags = (
            ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit
            if proc_closes_with_init
            else ControlFlags.StreamOpenBit
        )

        try:
            send_fn(
                PartialTransportMessage(
                    payload=init,
                    stream_id=stream_id,
                    control_flags=init_flags,
                    service_name=service_name,
                    procedure_name=procedure_name,
                )
            )
        except RuntimeError as e:
            # Session dead at send time
            try:
                res_readable._push_value(
                    err_result(
                        UNEXPECTED_DISCONNECT_CODE,
                        f"{to} unexpectedly disconnected",
                    )
                )
                res_readable._trigger_close()
            except RuntimeError:
                pass
            req_writable._closed = True
            cleanup()
            return {
                "res_readable": res_readable,
                "req_writable": req_writable,
            }

        # For rpc/subscription, close request side immediately
        if proc_closes_with_init:
            req_writable._closed = True

        return {
            "res_readable": res_readable,
            "req_writable": req_writable,
        }
