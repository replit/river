"""Generated type definitions for River services."""

from __future__ import annotations

from typing import Literal

from typing_extensions import NotRequired, TypedDict


class TestAddInit(TypedDict):
    n: float


class TestAddOutput(TypedDict):
    result: float


class TestEchoInit(TypedDict):
    pass


class TestEchoInput(TypedDict):
    msg: str
    ignore: NotRequired[bool]


class TestEchoOutput(TypedDict):
    response: str


class TestEchoWithPrefixInit(TypedDict):
    prefix: str


class TestEchoWithPrefixInput(TypedDict):
    msg: str
    ignore: NotRequired[bool]


class TestEchoWithPrefixOutput(TypedDict):
    response: str


class TestEchoBinaryInit(TypedDict):
    data: bytes


class TestEchoBinaryOutput(TypedDict):
    data: bytes
    length: float


class OrderingAddInit(TypedDict):
    n: float


class OrderingAddOutput(TypedDict):
    n: float


class OrderingGetAllInit(TypedDict):
    pass


class OrderingGetAllOutput(TypedDict):
    msgs: list[float]


class FallibleDivideInit(TypedDict):
    a: float
    b: float


class FallibleDivideOutput(TypedDict):
    result: float


class FallibleDivideErrorDivByZero(TypedDict):
    code: Literal["DIV_BY_ZERO"]
    message: str


class FallibleDivideErrorInfinity(TypedDict):
    code: Literal["INFINITY"]
    message: str


class FallibleEchoInit(TypedDict):
    pass


class FallibleEchoInput(TypedDict):
    msg: str
    throwResult: NotRequired[bool]
    throwError: NotRequired[bool]


class FallibleEchoOutput(TypedDict):
    response: str


class FallibleEchoError(TypedDict):
    code: Literal["STREAM_ERROR"]
    message: str


class SubscribableAddInit(TypedDict):
    n: float


class SubscribableAddOutput(TypedDict):
    result: float


class SubscribableValueInit(TypedDict):
    pass


class SubscribableValueOutput(TypedDict):
    count: float


class UploadableAddMultipleInit(TypedDict):
    pass


class UploadableAddMultipleInput(TypedDict):
    n: float


class UploadableAddMultipleOutput(TypedDict):
    result: float


class UploadableAddMultipleWithPrefixInit(TypedDict):
    prefix: str


class UploadableAddMultipleWithPrefixInput(TypedDict):
    n: float


class UploadableAddMultipleWithPrefixOutput(TypedDict):
    result: str


class UploadableCancellableAddInit(TypedDict):
    pass


class UploadableCancellableAddInput(TypedDict):
    n: float


class UploadableCancellableAddOutput(TypedDict):
    result: float


class CancelBlockingRpcInit(TypedDict):
    pass


class CancelBlockingRpcOutput(TypedDict):
    pass


class CancelBlockingStreamInit(TypedDict):
    pass


class CancelBlockingStreamInput(TypedDict):
    pass


class CancelBlockingStreamOutput(TypedDict):
    pass


class CancelBlockingUploadInit(TypedDict):
    pass


class CancelBlockingUploadInput(TypedDict):
    pass


class CancelBlockingUploadOutput(TypedDict):
    pass


class CancelBlockingSubscriptionInit(TypedDict):
    pass


class CancelBlockingSubscriptionOutput(TypedDict):
    pass


class CancelImmediateRpcInit(TypedDict):
    pass


class CancelImmediateRpcOutput(TypedDict):
    done: bool


class CancelImmediateStreamInit(TypedDict):
    pass


class CancelImmediateStreamInput(TypedDict):
    pass


class CancelImmediateStreamOutput(TypedDict):
    done: bool


class CancelImmediateUploadInit(TypedDict):
    pass


class CancelImmediateUploadInput(TypedDict):
    pass


class CancelImmediateUploadOutput(TypedDict):
    done: bool


class CancelImmediateSubscriptionInit(TypedDict):
    pass


class CancelImmediateSubscriptionOutput(TypedDict):
    done: bool


class CancelCountedStreamInit(TypedDict):
    total: float


class CancelCountedStreamInput(TypedDict):
    pass


class CancelCountedStreamOutput(TypedDict):
    i: float
