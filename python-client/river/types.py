"""Core types for the River protocol."""

from __future__ import annotations

import string
import random
from dataclasses import dataclass, field
from enum import IntFlag
from typing import Any, TypeVar, Generic, Union


# --- ID Generation ---

_ID_ALPHABET = string.ascii_letters + string.digits
_ID_LENGTH = 12


def generate_id() -> str:
    """Generate a nanoid-style random ID (12 chars, alphanumeric)."""
    return "".join(random.choices(_ID_ALPHABET, k=_ID_LENGTH))


# --- Control Flags ---


class ControlFlags(IntFlag):
    """Bit flags for transport message control signals."""

    AckBit = 0b00001  # 1 - heartbeat/ack only
    StreamOpenBit = 0b00010  # 2 - first message of a stream
    StreamCancelBit = 0b00100  # 4 - abrupt cancel with ProtocolError payload
    StreamClosedBit = 0b01000  # 8 - last message of a stream


def is_ack(flags: int) -> bool:
    return (flags & ControlFlags.AckBit) == ControlFlags.AckBit


def is_stream_open(flags: int) -> bool:
    return (flags & ControlFlags.StreamOpenBit) == ControlFlags.StreamOpenBit


def is_stream_cancel(flags: int) -> bool:
    return (flags & ControlFlags.StreamCancelBit) == ControlFlags.StreamCancelBit


def is_stream_close(flags: int) -> bool:
    return (flags & ControlFlags.StreamClosedBit) == ControlFlags.StreamClosedBit


# --- Transport Message ---


@dataclass
class TransportMessage:
    """The envelope for all messages sent over the wire."""

    id: str
    from_: str  # 'from' is a Python keyword
    to: str
    seq: int
    ack: int
    payload: Any
    stream_id: str
    control_flags: int = 0
    service_name: str | None = None
    procedure_name: str | None = None
    tracing: dict[str, str] | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a dict matching the wire format."""
        d: dict[str, Any] = {
            "id": self.id,
            "from": self.from_,
            "to": self.to,
            "seq": self.seq,
            "ack": self.ack,
            "payload": self.payload,
            "streamId": self.stream_id,
            "controlFlags": self.control_flags,
        }
        if self.service_name is not None:
            d["serviceName"] = self.service_name
        if self.procedure_name is not None:
            d["procedureName"] = self.procedure_name
        if self.tracing is not None:
            d["tracing"] = self.tracing
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> TransportMessage:
        """Deserialize from a wire format dict."""
        return cls(
            id=d["id"],
            from_=d["from"],
            to=d["to"],
            seq=d["seq"],
            ack=d["ack"],
            payload=d["payload"],
            stream_id=d["streamId"],
            control_flags=d.get("controlFlags", 0),
            service_name=d.get("serviceName"),
            procedure_name=d.get("procedureName"),
            tracing=d.get("tracing"),
        )


@dataclass
class PartialTransportMessage:
    """A transport message missing id, from, to, seq, ack -- filled in by Session."""

    payload: Any
    stream_id: str
    control_flags: int = 0
    service_name: str | None = None
    procedure_name: str | None = None
    tracing: dict[str, str] | None = None


# --- Result Types ---

T = TypeVar("T")
E = TypeVar("E")


@dataclass
class OkResult(Generic[T]):
    """Success result."""

    payload: T
    ok: bool = field(default=True, init=False)


@dataclass
class ErrResult(Generic[E]):
    """Error result."""

    payload: E
    ok: bool = field(default=False, init=False)


Result = Union[OkResult[T], ErrResult[E]]


def Ok(payload: Any) -> OkResult:
    """Create an Ok result."""
    return OkResult(payload=payload)


def Err(payload: Any) -> ErrResult:
    """Create an Err result."""
    return ErrResult(payload=payload)


def ok_result(payload: Any) -> dict[str, Any]:
    """Create an ok result dict for wire format."""
    return {"ok": True, "payload": payload}


def err_result(code: str, message: str, extras: Any = None) -> dict[str, Any]:
    """Create an error result dict for wire format."""
    p: dict[str, Any] = {"code": code, "message": message}
    if extras is not None:
        p["extras"] = extras
    return {"ok": False, "payload": p}


# --- Protocol Error Codes ---

UNEXPECTED_DISCONNECT_CODE = "UNEXPECTED_DISCONNECT"
CANCEL_CODE = "CANCEL"
UNCAUGHT_ERROR_CODE = "UNCAUGHT_ERROR"
INVALID_REQUEST_CODE = "INVALID_REQUEST"

# --- Protocol Version ---

PROTOCOL_VERSION = "v2.0"


# --- Control Message Helpers ---


def handshake_request_payload(
    session_id: str,
    next_expected_seq: int,
    next_sent_seq: int,
    metadata: Any = None,
) -> dict[str, Any]:
    """Create a handshake request payload."""
    payload: dict[str, Any] = {
        "type": "HANDSHAKE_REQ",
        "protocolVersion": PROTOCOL_VERSION,
        "sessionId": session_id,
        "expectedSessionState": {
            "nextExpectedSeq": next_expected_seq,
            "nextSentSeq": next_sent_seq,
        },
    }
    if metadata is not None:
        payload["metadata"] = metadata
    return payload


def handshake_response_ok(session_id: str) -> dict[str, Any]:
    return {
        "type": "HANDSHAKE_RESP",
        "status": {"ok": True, "sessionId": session_id},
    }


def ack_payload() -> dict[str, str]:
    """Heartbeat/ACK control payload."""
    return {"type": "ACK"}


def close_payload() -> dict[str, str]:
    """Stream close control payload."""
    return {"type": "CLOSE"}


def close_stream_message(stream_id: str) -> PartialTransportMessage:
    """Create a close stream partial message."""
    return PartialTransportMessage(
        payload=close_payload(),
        stream_id=stream_id,
        control_flags=ControlFlags.StreamClosedBit,
    )


def cancel_message(stream_id: str, error_payload: dict) -> PartialTransportMessage:
    """Create a cancel stream partial message."""
    return PartialTransportMessage(
        payload=error_payload,
        stream_id=stream_id,
        control_flags=ControlFlags.StreamCancelBit,
    )


def heartbeat_message() -> PartialTransportMessage:
    """Create a heartbeat partial message."""
    return PartialTransportMessage(
        payload=ack_payload(),
        stream_id="heartbeat",
        control_flags=ControlFlags.AckBit,
    )


# --- Handshake Error Codes ---

RETRIABLE_HANDSHAKE_CODES = frozenset({"SESSION_STATE_MISMATCH"})
FATAL_HANDSHAKE_CODES = frozenset(
    {
        "MALFORMED_HANDSHAKE_META",
        "MALFORMED_HANDSHAKE",
        "PROTOCOL_VERSION_MISMATCH",
        "REJECTED_BY_CUSTOM_HANDLER",
        "REJECTED_UNSUPPORTED_CLIENT",
    }
)
