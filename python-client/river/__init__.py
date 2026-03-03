"""River protocol v2.0 Python client implementation.

This client was generated with the assistance of AI (Claude).
"""

from river.client import (
    ErrResult,
    OkResult,
    RiverClient,
    StreamResult,
    SubscriptionResult,
    UploadResult,
)
from river.codec import BinaryCodec, NaiveJsonCodec
from river.streams import Readable, Writable
from river.transport import WebSocketClientTransport
from river.types import Err, Ok, TransportMessage

__all__ = [
    "RiverClient",
    "OkResult",
    "ErrResult",
    "StreamResult",
    "UploadResult",
    "SubscriptionResult",
    "WebSocketClientTransport",
    "NaiveJsonCodec",
    "BinaryCodec",
    "TransportMessage",
    "Ok",
    "Err",
    "Readable",
    "Writable",
]
