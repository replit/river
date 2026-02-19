"""Codec layer for encoding/decoding transport messages."""

from __future__ import annotations

import json
import base64
from abc import ABC, abstractmethod
from typing import Any

from river.types import TransportMessage


class Codec(ABC):
    """Abstract codec for encoding/decoding objects to/from bytes."""

    @abstractmethod
    def to_buffer(self, obj: dict[str, Any]) -> bytes:
        """Encode an object to bytes."""
        ...

    @abstractmethod
    def from_buffer(self, buf: bytes) -> dict[str, Any]:
        """Decode bytes to an object."""
        ...


class _CustomEncoder(json.JSONEncoder):
    """JSON encoder with support for bytes and large ints."""

    def default(self, o: Any) -> Any:
        if isinstance(o, (bytes, bytearray)):
            return {"$t": base64.b64encode(o).decode("ascii")}
        return super().default(o)


def _custom_object_hook(obj: dict) -> Any:
    """JSON decoder hook for custom types."""
    if "$t" in obj and len(obj) == 1:
        return base64.b64decode(obj["$t"])
    if "$b" in obj and len(obj) == 1:
        return int(obj["$b"])
    return obj


class NaiveJsonCodec(Codec):
    """Codec using JSON serialization (matches TypeScript NaiveJsonCodec)."""

    name = "naive"

    def to_buffer(self, obj: dict[str, Any]) -> bytes:
        return json.dumps(obj, cls=_CustomEncoder, separators=(",", ":")).encode(
            "utf-8"
        )

    def from_buffer(self, buf: bytes) -> dict[str, Any]:
        return json.loads(buf.decode("utf-8"), object_hook=_custom_object_hook)


class BinaryCodec(Codec):
    """Codec using msgpack serialization (matches TypeScript BinaryCodec)."""

    name = "binary"

    def to_buffer(self, obj: dict[str, Any]) -> bytes:
        import msgpack  # type: ignore[import-untyped]

        return msgpack.packb(obj, use_bin_type=True)

    def from_buffer(self, buf: bytes) -> dict[str, Any]:
        import msgpack  # type: ignore[import-untyped]

        return msgpack.unpackb(buf, raw=False)


class CodecMessageAdapter:
    """Wraps a Codec with error handling and validation for TransportMessage."""

    def __init__(self, codec: Codec) -> None:
        self._codec = codec

    def to_buffer(self, msg: TransportMessage) -> tuple[bool, bytes | str]:
        """Serialize a TransportMessage to bytes.

        Returns (True, bytes) on success, (False, error_reason) on failure.
        """
        try:
            raw = msg.to_dict()
            buf = self._codec.to_buffer(raw)
            return True, buf
        except Exception as e:
            return False, f"Failed to serialize message: {e}"

    def from_buffer(self, buf: bytes) -> tuple[bool, TransportMessage | str]:
        """Deserialize bytes to a TransportMessage.

        Returns (True, TransportMessage) on success, (False, error_reason) on failure.
        """
        try:
            raw = self._codec.from_buffer(buf)
            if not isinstance(raw, dict):
                return False, f"Expected dict, got {type(raw).__name__}"
            # Validate required fields
            required = ("id", "from", "to", "seq", "ack", "payload", "streamId")
            for field in required:
                if field not in raw:
                    return False, f"Missing required field: {field}"
            msg = TransportMessage.from_dict(raw)
            return True, msg
        except Exception as e:
            return False, f"Failed to deserialize message: {e}"
