"""Codec layer for encoding/decoding transport messages."""

from __future__ import annotations

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


_BIGINT_EXT_TYPE = 0
_MSGPACK_INT_MAX = 2**64 - 1
_MSGPACK_INT_MIN = -(2**63)


class BinaryCodec(Codec):
    """Codec using msgpack serialization (matches TypeScript BinaryCodec)."""

    name = "binary"

    def to_buffer(self, obj: dict[str, Any]) -> bytes:
        import msgpack

        return msgpack.packb(obj, use_bin_type=True, default=self._ext_encode)

    def from_buffer(self, buf: bytes) -> dict[str, Any]:
        import msgpack

        return msgpack.unpackb(buf, raw=False, ext_hook=self._ext_decode)

    @staticmethod
    def _ext_encode(obj: Any) -> Any:
        import msgpack

        if isinstance(obj, int) and (obj > _MSGPACK_INT_MAX or obj < _MSGPACK_INT_MIN):
            # Encode as string in extension type 0 (matches TS BigInt ext)
            data = msgpack.packb(str(obj), use_bin_type=True)
            return msgpack.ExtType(_BIGINT_EXT_TYPE, data)
        raise TypeError(f"Unknown type: {type(obj)}")

    @staticmethod
    def _ext_decode(code: int, data: bytes) -> Any:
        import msgpack

        if code == _BIGINT_EXT_TYPE:
            val = msgpack.unpackb(data, raw=False)
            return int(val)
        return msgpack.ExtType(code, data)


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
            for f in required:
                if f not in raw:
                    return False, f"Missing required field: {f}"
            # Validate field types to prevent downstream crashes
            if not isinstance(raw["seq"], int):
                return False, (
                    f"Field 'seq' must be int, got {type(raw['seq']).__name__}"
                )
            if not isinstance(raw["ack"], int):
                return False, (
                    f"Field 'ack' must be int, got {type(raw['ack']).__name__}"
                )
            if not isinstance(raw["id"], str):
                return False, (
                    f"Field 'id' must be str, got {type(raw['id']).__name__}"
                )
            if not isinstance(raw["streamId"], str):
                return False, (
                    f"Field 'streamId' must be str, "
                    f"got {type(raw['streamId']).__name__}"
                )
            msg = TransportMessage.from_dict(raw)
            return True, msg
        except Exception as e:
            return False, f"Failed to deserialize message: {e}"
