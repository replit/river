"""Client transport layer for the River protocol.

Manages WebSocket connections, session lifecycle, handshake,
reconnection with backoff, and message dispatch.
"""

from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from typing import Any, Callable

from river.codec import Codec, CodecMessageAdapter, NaiveJsonCodec
from river.session import Session, SessionOptions, SessionState, DEFAULT_SESSION_OPTIONS
from river.types import (
    ControlFlags,
    PartialTransportMessage,
    TransportMessage,
    generate_id,
    is_ack,
    is_stream_cancel,
    is_stream_close,
    is_stream_open,
    RETRIABLE_HANDSHAKE_CODES,
    FATAL_HANDSHAKE_CODES,
    UNEXPECTED_DISCONNECT_CODE,
    err_result,
)

logger = logging.getLogger(__name__)


class EventDispatcher:
    """Simple event dispatcher with typed event names."""

    def __init__(self) -> None:
        self._handlers: dict[str, set[Callable]] = {}

    def add_listener(self, event: str, handler: Callable) -> None:
        if event not in self._handlers:
            self._handlers[event] = set()
        self._handlers[event].add(handler)

    def remove_listener(self, event: str, handler: Callable) -> None:
        if event in self._handlers:
            self._handlers[event].discard(handler)

    def dispatch(self, event: str, data: Any = None) -> None:
        if event in self._handlers:
            # Copy to avoid mutation during iteration
            for handler in list(self._handlers[event]):
                try:
                    handler(data)
                except Exception as e:
                    logger.error("Event handler error for %s: %s", event, e)

    def listener_count(self, event: str) -> int:
        return len(self._handlers.get(event, set()))


class LeakyBucketRateLimit:
    """Rate limiter with exponential backoff for connection retries."""

    def __init__(
        self,
        base_interval_ms: float = 150,
        max_jitter_ms: float = 200,
        max_backoff_ms: float = 32_000,
        attempt_budget_capacity: int = 5,
        budget_restore_interval_ms: float = 200,
    ) -> None:
        self.base_interval_ms = base_interval_ms
        self.max_jitter_ms = max_jitter_ms
        self.max_backoff_ms = max_backoff_ms
        self.attempt_budget_capacity = attempt_budget_capacity
        self.budget_restore_interval_ms = budget_restore_interval_ms
        self.budget_consumed: int = 0
        self._restore_task: asyncio.Task | None = None

    def has_budget(self) -> bool:
        return self.budget_consumed < self.attempt_budget_capacity

    def get_backoff_ms(self) -> float:
        if self.budget_consumed == 0:
            return 0
        exponent = max(0, self.budget_consumed - 1)
        jitter = random.random() * self.max_jitter_ms
        backoff = min(
            self.base_interval_ms * (2**exponent), self.max_backoff_ms
        )
        return backoff + jitter

    def consume_budget(self) -> None:
        self._stop_restore()
        self.budget_consumed += 1

    def start_restoring_budget(self) -> None:
        """Start gradually restoring budget after a successful connection."""
        self._stop_restore()

        async def _restore_loop():
            try:
                while self.budget_consumed > 0:
                    await asyncio.sleep(
                        self.budget_restore_interval_ms / 1000.0
                    )
                    self.budget_consumed = max(0, self.budget_consumed - 1)
            except asyncio.CancelledError:
                pass

        try:
            loop = asyncio.get_event_loop()
            self._restore_task = loop.create_task(_restore_loop())
        except RuntimeError:
            pass

    def _stop_restore(self) -> None:
        if self._restore_task:
            self._restore_task.cancel()
            self._restore_task = None

    def reset(self) -> None:
        self.budget_consumed = 0
        self._stop_restore()


class WebSocketClientTransport:
    """Client-side transport managing WebSocket connections and sessions.

    Handles connection lifecycle, handshakes, reconnection with backoff,
    heartbeat echo, and message dispatch.
    """

    def __init__(
        self,
        ws_url: str | Callable[..., str],
        client_id: str | None = None,
        server_id: str | None = None,
        codec: Codec | None = None,
        options: SessionOptions | None = None,
        handshake_metadata: Any = None,
        connect_on_invoke: bool = True,
        eagerly_connect: bool = False,
    ) -> None:
        self.client_id = client_id or generate_id()
        self.server_id = server_id or "SERVER"
        self._ws_url = ws_url
        self._codec = codec or NaiveJsonCodec()
        self._codec_adapter = CodecMessageAdapter(self._codec)
        self.options = options or DEFAULT_SESSION_OPTIONS
        self._handshake_metadata = handshake_metadata
        self._connect_on_invoke = connect_on_invoke

        # State
        self._status: str = "open"  # 'open' | 'closed'
        self.sessions: dict[str, Session] = {}  # to_id -> Session
        self._events = EventDispatcher()
        self._retry_budget = LeakyBucketRateLimit()
        self._reconnect_on_connection_drop = True

        # Connection tasks
        self._connect_tasks: dict[str, asyncio.Task] = {}

        self._loop: asyncio.AbstractEventLoop | None = None

    def get_status(self) -> str:
        return self._status

    def _get_loop(self) -> asyncio.AbstractEventLoop:
        if self._loop is None:
            self._loop = asyncio.get_event_loop()
        return self._loop

    # --- Event API ---

    def add_event_listener(self, event: str, handler: Callable) -> None:
        self._events.add_listener(event, handler)

    def remove_event_listener(self, event: str, handler: Callable) -> None:
        self._events.remove_listener(event, handler)

    # --- Session Management ---

    def _get_or_create_session(self, to: str) -> Session:
        """Get an existing session or create a new unconnected one."""
        if to in self.sessions:
            return self.sessions[to]
        session = Session(
            session_id=generate_id(),
            from_id=self.client_id,
            to_id=to,
            codec=self._codec_adapter,
            options=self.options,
        )
        session._on_session_grace_elapsed = lambda: self._on_session_grace_elapsed(to)
        self.sessions[to] = session
        self._events.dispatch(
            "sessionStatus", {"status": "created", "session": session}
        )
        return session

    def _delete_session(self, to: str, emit_closing: bool = True) -> None:
        """Delete a session and clean up."""
        session = self.sessions.pop(to, None)
        if session is None:
            return
        if emit_closing:
            self._events.dispatch(
                "sessionStatus", {"status": "closing", "session": session}
            )
        session.destroy()
        self._events.dispatch(
            "sessionStatus", {"status": "closed", "session": session}
        )

    def _on_session_grace_elapsed(self, to: str) -> None:
        """Called when a session's grace period expires."""
        logger.debug("Session grace period elapsed for %s", to)
        self._delete_session(to)

    # --- Connection Flow ---

    def connect(self, to: str | None = None) -> None:
        """Initiate a connection to the given server.

        Follows the state transition:
        NoConnection -> BackingOff -> Connecting -> Handshaking -> Connected
        """
        to = to or self.server_id
        if self._status != "open":
            return

        session = self._get_or_create_session(to)
        if session.state != SessionState.NO_CONNECTION:
            return  # Already connecting/connected

        if not self._retry_budget.has_budget():
            self._events.dispatch(
                "protocolError",
                {"type": "conn_retry_exceeded", "message": "Retries exceeded"},
            )
            return

        backoff_ms = self._retry_budget.get_backoff_ms()
        self._retry_budget.consume_budget()

        # Schedule the connection attempt after backoff
        loop = self._get_loop()
        session.state = SessionState.BACKING_OFF

        async def _do_connect():
            try:
                if backoff_ms > 0:
                    await asyncio.sleep(backoff_ms / 1000.0)

                if self._status != "open" or session._destroyed:
                    return

                session.state = SessionState.CONNECTING
                ws = await self._create_connection(to)

                if session._destroyed:
                    await ws.close()
                    return

                session.state = SessionState.HANDSHAKING
                await self._do_handshake(session, ws, to)
            except asyncio.CancelledError:
                pass
            except Exception as e:
                logger.debug("Connection attempt failed for %s: %s", to, e)
                if not session._destroyed:
                    self._on_connection_failed(to)

        task = loop.create_task(_do_connect())
        self._connect_tasks[to] = task

    async def _create_connection(self, to: str) -> Any:
        """Create a new WebSocket connection."""
        import websockets  # type: ignore[import-untyped]

        url = self._ws_url if isinstance(self._ws_url, str) else self._ws_url(to)

        ws = await asyncio.wait_for(
            websockets.connect(url, max_size=None, ping_interval=None, ping_timeout=None),
            timeout=self.options.connection_timeout_ms / 1000.0,
        )
        return ws

    async def _do_handshake(
        self, session: Session, ws: Any, to: str
    ) -> None:
        """Perform the handshake on a newly connected WebSocket."""
        # Send handshake request
        hs_msg = session.create_handshake_request(
            metadata=self._handshake_metadata
        )
        ok, buf = self._codec_adapter.to_buffer(hs_msg)
        if not ok:
            logger.error("Failed to encode handshake: %s", buf)
            await ws.close()
            self._on_connection_failed(to)
            return

        await ws.send(buf)

        # Wait for handshake response
        try:
            response_bytes = await asyncio.wait_for(
                ws.recv(), timeout=self.options.handshake_timeout_ms / 1000.0
            )
        except (asyncio.TimeoutError, Exception) as e:
            logger.debug("Handshake timeout/error for %s: %s", to, e)
            await ws.close()
            self._on_connection_failed(to)
            return

        if isinstance(response_bytes, str):
            response_bytes = response_bytes.encode("utf-8")

        ok, result = self._codec_adapter.from_buffer(response_bytes)
        if not ok:
            logger.error("Failed to decode handshake response: %s", result)
            await ws.close()
            self._on_connection_failed(to)
            return

        response_msg: TransportMessage = result  # type: ignore[assignment]
        payload = response_msg.payload

        # Validate handshake response
        if (
            not isinstance(payload, dict)
            or payload.get("type") != "HANDSHAKE_RESP"
        ):
            logger.error("Invalid handshake response payload")
            await ws.close()
            self._on_connection_failed(to)
            return

        status = payload.get("status", {})
        if not status.get("ok"):
            code = status.get("code", "UNKNOWN")
            reason = status.get("reason", "Unknown reason")
            logger.debug(
                "Handshake rejected for %s: %s (%s)", to, reason, code
            )
            await ws.close()

            if code in RETRIABLE_HANDSHAKE_CODES:
                # Session state mismatch - destroy session and retry
                self._delete_session(to)
                self._try_reconnecting(to)
            else:
                self._events.dispatch(
                    "protocolError",
                    {
                        "type": "handshake_failed",
                        "message": reason,
                        "code": code,
                    },
                )
                self._on_connection_failed(to)
            return

        # Check session ID match
        resp_session_id = status.get("sessionId")
        if resp_session_id != session.id:
            # Server assigned a different session - old session is stale
            logger.debug(
                "Session ID mismatch: expected %s, got %s",
                session.id,
                resp_session_id,
            )
            # The server lost our session state; destroy old and create new
            self._delete_session(to, emit_closing=True)
            self._try_reconnecting(to)
            return

        # Handshake successful
        loop = self._get_loop()
        session.set_connected(ws, loop)
        self._events.dispatch(
            "sessionTransition",
            {"state": SessionState.CONNECTED, "id": session.id},
        )

        # Retransmit buffered messages
        ok, err = session.send_buffered_messages()
        if not ok:
            logger.error("Failed to send buffered messages: %s", err)
            self._events.dispatch(
                "protocolError",
                {"type": "message_send_failure", "message": err},
            )
            self._delete_session(to)
            return

        # Start restoring retry budget
        self._retry_budget.start_restoring_budget()

        # Start listening for messages
        self._start_message_listener(session, ws, to)

    def _start_message_listener(
        self, session: Session, ws: Any, to: str
    ) -> None:
        """Start the async message listener on the WebSocket."""
        loop = self._get_loop()

        session._on_connection_closed = lambda: self._on_connection_dropped(to)

        async def _listen():
            try:
                async for raw_msg in ws:
                    if session._destroyed:
                        break
                    if isinstance(raw_msg, str):
                        raw_msg = raw_msg.encode("utf-8")
                    self._on_message_data(session, raw_msg, to)
            except Exception as e:
                if not session._destroyed:
                    logger.debug(
                        "WebSocket error for session %s: %s", session.id, e
                    )
            finally:
                if not session._destroyed:
                    self._on_connection_dropped(to)

        loop.create_task(_listen())

    def _on_message_data(
        self, session: Session, raw: bytes, to: str
    ) -> None:
        """Handle raw bytes received from the WebSocket."""
        ok, result = self._codec_adapter.from_buffer(raw)
        if not ok:
            self._events.dispatch(
                "protocolError",
                {"type": "invalid_message", "message": result},
            )
            return

        msg: TransportMessage = result  # type: ignore[assignment]

        # Check message ordering
        if msg.seq != session.ack:
            if msg.seq < session.ack:
                # Duplicate - discard silently
                return
            else:
                # Future message - close connection to force re-handshake
                logger.debug(
                    "Seq out of order: expected %d, got %d. Closing.",
                    session.ack,
                    msg.seq,
                )
                if session._ws:
                    asyncio.ensure_future(session._ws.close())
                return

        # Update bookkeeping
        session.update_bookkeeping(msg.ack, msg.seq)

        # Dispatch non-heartbeat messages
        if not is_ack(msg.control_flags):
            self._events.dispatch("message", msg)
            return

        # If this is a heartbeat and we're not actively heartbeating (client),
        # echo back
        if not session._is_actively_heartbeating:
            session.send_heartbeat()

    def _on_connection_dropped(self, to: str) -> None:
        """Handle a dropped connection."""
        session = self.sessions.get(to)
        if session is None or session._destroyed:
            return
        if session.state != SessionState.CONNECTED:
            return

        loop = self._get_loop()
        session.set_disconnected(loop)
        self._events.dispatch(
            "sessionTransition",
            {"state": SessionState.NO_CONNECTION, "id": session.id},
        )

        if self._reconnect_on_connection_drop:
            self._try_reconnecting(to)

    def _on_connection_failed(self, to: str) -> None:
        """Handle a failed connection attempt."""
        session = self.sessions.get(to)
        if session is None or session._destroyed:
            return

        loop = self._get_loop()
        session.state = SessionState.NO_CONNECTION

        if self._reconnect_on_connection_drop:
            self._try_reconnecting(to)

    def _try_reconnecting(self, to: str) -> None:
        """Try to reconnect to the server."""
        if self._status != "open":
            return
        if not self._reconnect_on_connection_drop:
            return
        # Use call_soon to break out of the current call stack
        loop = self._get_loop()
        loop.call_soon(lambda: self.connect(to))

    # --- Session-Bound Send ---

    def get_session_bound_send_fn(
        self, to: str, session_id: str
    ) -> Callable[[PartialTransportMessage], str]:
        """Get a send function scoped to a specific session.

        The send function will raise if the session has been replaced or destroyed.
        """

        def _send(msg: PartialTransportMessage) -> str:
            session = self.sessions.get(to)
            if session is None:
                raise RuntimeError("Session scope ended (closed)")
            if session.id != session_id or session._destroyed:
                raise RuntimeError("Session scope ended (transition)")

            ok, result = session.send(msg)
            if not ok:
                raise RuntimeError(f"Send failed: {result}")
            return result

        return _send

    # --- Lifecycle ---

    async def close(self) -> None:
        """Close the transport and all sessions."""
        if self._status == "closed":
            return
        self._status = "closed"

        # Cancel all pending connection tasks
        for task in self._connect_tasks.values():
            task.cancel()
        self._connect_tasks.clear()

        # Delete all sessions
        for to in list(self.sessions.keys()):
            self._delete_session(to)

        self._retry_budget.reset()
        self._events.dispatch("transportStatus", {"status": "closed"})

    @property
    def reconnect_on_connection_drop(self) -> bool:
        return self._reconnect_on_connection_drop

    @reconnect_on_connection_drop.setter
    def reconnect_on_connection_drop(self, value: bool) -> None:
        self._reconnect_on_connection_drop = value
