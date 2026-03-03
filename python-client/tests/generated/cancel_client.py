"""Generated client for the cancel service."""

from __future__ import annotations

import asyncio
from typing import Any

from river.client import (
    ErrResult,
    OkResult,
    RiverClient,
    StreamResult,
    SubscriptionResult,
    UploadResult,
)

from ._types import (
    CancelBlockingRpcInit,
    CancelBlockingRpcOutput,
    CancelBlockingStreamInit,
    CancelBlockingStreamInput,
    CancelBlockingStreamOutput,
    CancelBlockingSubscriptionInit,
    CancelBlockingSubscriptionOutput,
    CancelBlockingUploadInit,
    CancelBlockingUploadInput,
    CancelBlockingUploadOutput,
    CancelCountedStreamInit,
    CancelCountedStreamInput,
    CancelCountedStreamOutput,
    CancelImmediateRpcInit,
    CancelImmediateRpcOutput,
    CancelImmediateStreamInit,
    CancelImmediateStreamInput,
    CancelImmediateStreamOutput,
    CancelImmediateSubscriptionInit,
    CancelImmediateSubscriptionOutput,
    CancelImmediateUploadInit,
    CancelImmediateUploadInput,
    CancelImmediateUploadOutput,
)

from ._errors import ProtocolError


class CancelClient:
    """Typed client for the ``cancel`` service."""

    def __init__(self, client: RiverClient) -> None:
        self._client = client

    async def blocking_rpc(
        self,
        init: CancelBlockingRpcInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> OkResult[CancelBlockingRpcOutput] | ErrResult[ProtocolError]:
        return await self._client.rpc(
            "cancel",
            "blockingRpc",
            init,
            abort_signal=abort_signal,
        )

    def blocking_stream(
        self,
        init: CancelBlockingStreamInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> StreamResult[CancelBlockingStreamInput]:
        return self._client.stream(
            "cancel",
            "blockingStream",
            init,
            abort_signal=abort_signal,
        )

    def blocking_upload(
        self,
        init: CancelBlockingUploadInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> UploadResult[CancelBlockingUploadInput]:
        return self._client.upload(
            "cancel",
            "blockingUpload",
            init,
            abort_signal=abort_signal,
        )

    def blocking_subscription(
        self,
        init: CancelBlockingSubscriptionInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> SubscriptionResult:
        return self._client.subscribe(
            "cancel",
            "blockingSubscription",
            init,
            abort_signal=abort_signal,
        )

    async def immediate_rpc(
        self,
        init: CancelImmediateRpcInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> OkResult[CancelImmediateRpcOutput] | ErrResult[ProtocolError]:
        return await self._client.rpc(
            "cancel",
            "immediateRpc",
            init,
            abort_signal=abort_signal,
        )

    def immediate_stream(
        self,
        init: CancelImmediateStreamInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> StreamResult[CancelImmediateStreamInput]:
        return self._client.stream(
            "cancel",
            "immediateStream",
            init,
            abort_signal=abort_signal,
        )

    def immediate_upload(
        self,
        init: CancelImmediateUploadInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> UploadResult[CancelImmediateUploadInput]:
        return self._client.upload(
            "cancel",
            "immediateUpload",
            init,
            abort_signal=abort_signal,
        )

    def immediate_subscription(
        self,
        init: CancelImmediateSubscriptionInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> SubscriptionResult:
        return self._client.subscribe(
            "cancel",
            "immediateSubscription",
            init,
            abort_signal=abort_signal,
        )

    def counted_stream(
        self,
        init: CancelCountedStreamInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> StreamResult[CancelCountedStreamInput]:
        return self._client.stream(
            "cancel",
            "countedStream",
            init,
            abort_signal=abort_signal,
        )
