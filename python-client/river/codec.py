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
# Use JS Number.MAX_SAFE_INTEGER bounds, not msgpack's 64-bit range.
# Values outside this range lose precision when decoded as JS numbers.
_MAX_SAFE_INTEGER = 2**53 - 1
_MIN_SAFE_INTEGER = -(2**53 - 1)


class BinaryCodec(Codec):
    """Codec using msgpack serialization (matches TypeScript BinaryCodec)."""

    name = "binary"

    def to_buffer(self, obj: dict[str, Any]) -> bytes:
        import msgpack

        return msgpack.packb(self._prepare(obj), use_bin_type=True)

    def from_buffer(self, buf: bytes) -> dict[str, Any]:
        import msgpack

        return msgpack.unpackb(buf, raw=False, ext_hook=self._ext_decode)

    @staticmethod
    def _prepare(obj: Any) -> Any:
        """Walk *obj* and replace ints outside JS safe range with ExtType."""
        import msgpack

        if isinstance(obj, dict):
            return {k: BinaryCodec._prepare(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)):
            return [BinaryCodec._prepare(v) for v in obj]
        if isinstance(obj, int) and not isinstance(obj, bool) and (
            obj > _MAX_SAFE_INTEGER or obj < _MIN_SAFE_INTEGER
        ):
            data = msgpack.packb(str(obj), use_bin_type=True)
            return msgpack.ExtType(_BIGINT_EXT_TYPE, data)
        return obj

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
        Validation of required fields and types is handled by
        :meth:`TransportMessage.from_dict`.
        """
        try:
            raw = self._codec.from_buffer(buf)
            if not isinstance(raw, dict):
                return False, f"Expected dict, got {type(raw).__name__}"
            msg = TransportMessage.from_dict(raw)
            return True, msg
        except (KeyError, TypeError) as e:
            return False, str(e)
        except Exception as e:
            return False, f"Failed to deserialize message: {e}"
