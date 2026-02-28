"""Session state machine for River protocol.

Manages seq/ack bookkeeping, send buffers, and session lifecycle.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable

from river.codec import CodecMessageAdapter
from river.types import (
    ControlFlags,
    PartialTransportMessage,
    TransportMessage,
    generate_id,
    handshake_request_payload,
    heartbeat_message,
    is_ack,
    PROTOCOL_VERSION,
)

logger = logging.getLogger(__name__)


class SessionState(str, Enum):
    """Session state machine states."""

    NO_CONNECTION = "NoConnection"
    BACKING_OFF = "BackingOff"
    CONNECTING = "Connecting"
    HANDSHAKING = "Handshaking"
    CONNECTED = "Connected"


@dataclass
class SessionOptions:
    """Configuration options for a session."""

    heartbeat_interval_ms: float = 1000
    heartbeats_until_dead: int = 2
    session_disconnect_grace_ms: float = 5000
    connection_timeout_ms: float = 2000
    handshake_timeout_ms: float = 1000
    enable_transparent_reconnects: bool = True


DEFAULT_SESSION_OPTIONS = SessionOptions()


class Session:
    """Represents a River session with seq/ack bookkeeping and send buffer.

    A session persists across potentially multiple connections, tracking
    all the state needed for transparent reconnection.
    """

    def __init__(
        self,
        session_id: str,
        from_id: str,
        to_id: str,
        codec: CodecMessageAdapter,
        options: SessionOptions | None = None,
    ) -> None:
        self.id = session_id
        self.from_id = from_id
        self.to_id = to_id
        self.codec = codec
        self.options = options or DEFAULT_SESSION_OPTIONS

        # Seq/ack bookkeeping
        self.seq: int = 0  # Next seq to assign when sending
        self.ack: int = 0  # Next expected seq from the other side
        self.send_buffer: list[TransportMessage] = []

        # State machine
        self.state: SessionState = SessionState.NO_CONNECTION

        # Connection
        self._ws: Any = None  # The WebSocket connection
        self._is_actively_heartbeating: bool = False

        # Timers
        self._heartbeat_task: asyncio.Task | None = None
        self._heartbeat_miss_task: asyncio.Task | None = None
        self._grace_period_task: asyncio.Task | None = None
        self._grace_expiry_time: float | None = None

        # Callbacks
        self._on_message: Callable[[TransportMessage], None] | None = None
        self._on_connection_closed: Callable[[], None] | None = None
        self._on_session_grace_elapsed: Callable[[], None] | None = None

        self._destroyed = False

    @property
    def next_seq(self) -> int:
        """The next seq the other side should see from us.

        Returns the seq of the first unacked message in the buffer,
        or our current seq if the buffer is empty.
        """
        if self.send_buffer:
            return self.send_buffer[0].seq
        return self.seq

    def construct_msg(
        self, partial: PartialTransportMessage
    ) -> TransportMessage:
        """Construct a full TransportMessage from a partial one.

        Fills in id, from, to, seq, ack and increments seq.
        """
        msg = TransportMessage(
            id=generate_id(),
            from_=self.from_id,
            to=self.to_id,
            seq=self.seq,
            ack=self.ack,
            payload=partial.payload,
            stream_id=partial.stream_id,
            control_flags=partial.control_flags,
            service_name=partial.service_name,
            procedure_name=partial.procedure_name,
            tracing=partial.tracing,
        )
        self.seq += 1
        return msg

    def send(self, partial: PartialTransportMessage) -> tuple[bool, str]:
        """Construct and send a message.

        When connected, sends immediately over the wire and buffers.
        When disconnected, only buffers.

        Returns (True, msg_id) on success, (False, reason) on failure.
        """
        msg = self.construct_msg(partial)
        self.send_buffer.append(msg)

        if self.state == SessionState.CONNECTED and self._ws is not None:
            ok, result = self._send_over_wire(msg)
            if not ok:
                return False, result
        return True, msg.id

    def _send_over_wire(self, msg: TransportMessage) -> tuple[bool, str]:
        """Serialize and send a message over the current connection."""
        ok, result = self.codec.to_buffer(msg)
        if not ok:
            return False, result  # type: ignore[return-value]
        try:
            assert self._ws is not None
            # websockets library uses async send, but we schedule it
            asyncio.get_event_loop().call_soon(
                lambda data=result: self._do_ws_send(data)
            )
            return True, msg.id
        except Exception as e:
            return False, f"Failed to send: {e}"

    def _do_ws_send(self, data: bytes) -> None:
        """Actually send data over the WebSocket."""
        if self._ws is not None and not self._destroyed:
            try:
                asyncio.ensure_future(self._ws.send(data))
            except Exception as e:
                logger.error("WebSocket send error: %s", e)

    def send_buffered_messages(self) -> tuple[bool, str | None]:
        """Retransmit all buffered messages over the current connection.

        Called after a successful reconnection handshake.
        """
        for msg in self.send_buffer:
            ok, reason = self._send_over_wire(msg)
            if not ok:
                return False, reason
        return True, None

    def update_bookkeeping(self, their_ack: int, their_seq: int) -> None:
        """Update seq/ack bookkeeping based on an incoming message.

        - Removes acknowledged messages from the send buffer.
        - Updates our ack to their_seq + 1.
        - Resets the heartbeat miss timeout.
        """
        # Remove acked messages from send buffer
        self.send_buffer = [m for m in self.send_buffer if m.seq >= their_ack]
        # Update our ack
        self.ack = their_seq + 1
        # Reset heartbeat miss timer
        self._reset_heartbeat_miss_timeout()

    def send_heartbeat(self) -> None:
        """Send a heartbeat message."""
        self.send(heartbeat_message())

    def start_active_heartbeat(self, loop: asyncio.AbstractEventLoop) -> None:
        """Start sending heartbeats at the configured interval (server behavior)."""
        self._is_actively_heartbeating = True
        interval = self.options.heartbeat_interval_ms / 1000.0

        async def _heartbeat_loop():
            try:
                while not self._destroyed and self.state == SessionState.CONNECTED:
                    await asyncio.sleep(interval)
                    if not self._destroyed and self.state == SessionState.CONNECTED:
                        self.send_heartbeat()
            except asyncio.CancelledError:
                pass

        self._heartbeat_task = loop.create_task(_heartbeat_loop())

    def start_heartbeat_miss_timeout(self, loop: asyncio.AbstractEventLoop) -> None:
        """Start the missing heartbeat timeout."""
        miss_duration = (
            self.options.heartbeats_until_dead
            * self.options.heartbeat_interval_ms
            / 1000.0
        )

        async def _miss_timeout():
            try:
                await asyncio.sleep(miss_duration)
                if not self._destroyed and self._on_connection_closed:
                    logger.debug(
                        "Session %s: heartbeat miss timeout, closing connection",
                        self.id,
                    )
                    self._on_connection_closed()
            except asyncio.CancelledError:
                pass

        if self._heartbeat_miss_task:
            self._heartbeat_miss_task.cancel()
        self._heartbeat_miss_task = loop.create_task(_miss_timeout())

    def _reset_heartbeat_miss_timeout(self) -> None:
        """Reset the heartbeat miss timer."""
        if self._heartbeat_miss_task:
            self._heartbeat_miss_task.cancel()
            self._heartbeat_miss_task = None
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                self.start_heartbeat_miss_timeout(loop)
        except RuntimeError:
            pass

    def start_grace_period(self, loop: asyncio.AbstractEventLoop) -> None:
        """Start the session disconnect grace period.

        If the session is not reconnected within this time, it's destroyed.
        """
        grace_ms = self.options.session_disconnect_grace_ms
        self._grace_expiry_time = time.monotonic() + grace_ms / 1000.0

        async def _grace_timeout():
            try:
                await asyncio.sleep(grace_ms / 1000.0)
                if not self._destroyed and self._on_session_grace_elapsed:
                    logger.debug(
                        "Session %s: grace period elapsed, destroying", self.id
                    )
                    self._on_session_grace_elapsed()
            except asyncio.CancelledError:
                pass

        if self._grace_period_task:
            self._grace_period_task.cancel()
        self._grace_period_task = loop.create_task(_grace_timeout())

    def cancel_grace_period(self) -> None:
        """Cancel the session disconnect grace period."""
        if self._grace_period_task:
            self._grace_period_task.cancel()
            self._grace_period_task = None
        self._grace_expiry_time = None

    def cancel_heartbeats(self) -> None:
        """Cancel all heartbeat-related tasks."""
        if self._heartbeat_task:
            self._heartbeat_task.cancel()
            self._heartbeat_task = None
        if self._heartbeat_miss_task:
            self._heartbeat_miss_task.cancel()
            self._heartbeat_miss_task = None
        self._is_actively_heartbeating = False

    def set_connected(self, ws: Any, loop: asyncio.AbstractEventLoop) -> None:
        """Transition to connected state."""
        self.state = SessionState.CONNECTED
        self._ws = ws
        self.cancel_grace_period()
        self.start_heartbeat_miss_timeout(loop)

    def set_disconnected(self, loop: asyncio.AbstractEventLoop) -> None:
        """Transition to disconnected state (no connection)."""
        self.state = SessionState.NO_CONNECTION
        self.cancel_heartbeats()
        old_ws = self._ws
        self._ws = None
        if old_ws is not None:
            try:
                asyncio.ensure_future(old_ws.close())
            except Exception:
                pass
        self.start_grace_period(loop)

    def destroy(self) -> None:
        """Destroy the session, cleaning up all resources."""
        self._destroyed = True
        self.cancel_heartbeats()
        self.cancel_grace_period()
        if self._ws is not None:
            try:
                asyncio.ensure_future(self._ws.close())
            except Exception:
                pass
            self._ws = None
        self.send_buffer.clear()

    def create_handshake_request(
        self, metadata: Any = None
    ) -> TransportMessage:
        """Create a handshake request transport message.

        Handshake messages have seq=0, ack=0, controlFlags=0.
        """
        payload = handshake_request_payload(
            session_id=self.id,
            next_expected_seq=self.ack,
            next_sent_seq=self.next_seq,
            metadata=metadata,
        )
        return TransportMessage(
            id=generate_id(),
            from_=self.from_id,
            to=self.to_id,
            seq=0,
            ack=0,
            payload=payload,
            stream_id="handshake",
            control_flags=0,
        )
