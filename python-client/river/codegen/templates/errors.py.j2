"""Protocol-level error types for the River protocol.

These errors can be returned by any procedure regardless of its
service-specific error schema.
"""

from __future__ import annotations

from typing import Literal

from typing_extensions import NotRequired, TypedDict


class UncaughtError(TypedDict):
    code: Literal["UNCAUGHT_ERROR"]
    message: str


class UnexpectedDisconnect(TypedDict):
    code: Literal["UNEXPECTED_DISCONNECT"]
    message: str


class InvalidRequestExtrasItem(TypedDict):
    path: str
    message: str


class InvalidRequestExtras(TypedDict):
    firstValidationErrors: list[InvalidRequestExtrasItem]
    totalErrors: float


class InvalidRequest(TypedDict):
    code: Literal["INVALID_REQUEST"]
    message: str
    extras: NotRequired[InvalidRequestExtras]


class Cancel(TypedDict):
    code: Literal["CANCEL"]
    message: str


ProtocolError = UncaughtError | UnexpectedDisconnect | InvalidRequest | Cancel
