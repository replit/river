"""Generated client for the cancel service."""

from __future__ import annotations

import asyncio
from typing import Any

from river.client import RiverClient
from river.streams import Readable, Writable

from ._types import (
    CancelBlockingRpcInit,
    CancelBlockingStreamInit,
    CancelBlockingStreamInput,
    CancelBlockingSubscriptionInit,
    CancelBlockingUploadInit,
    CancelBlockingUploadInput,
    CancelCountedStreamInit,
    CancelCountedStreamInput,
    CancelImmediateRpcInit,
    CancelImmediateStreamInit,
    CancelImmediateStreamInput,
    CancelImmediateSubscriptionInit,
    CancelImmediateUploadInit,
    CancelImmediateUploadInput,
)


class CancelBlockingStreamStreamResult:
    """Streaming result for ``cancel.blockingStream``."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def req_writable(self) -> Writable[CancelBlockingStreamInput]:
        """Writable stream for sending requests."""
        return self._inner.req_writable

    @property
    def res_readable(self) -> Readable[dict[str, Any]]:
        """Readable stream for receiving responses."""
        return self._inner.res_readable


class CancelBlockingUploadUploadResult:
    """Upload result for ``cancel.blockingUpload``."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def req_writable(self) -> Writable[CancelBlockingUploadInput]:
        """Writable stream for sending requests."""
        return self._inner.req_writable

    async def finalize(self) -> dict[str, Any]:
        """Finalize the upload and get the response."""
        return await self._inner.finalize()


class CancelBlockingSubscriptionSubscriptionResult:
    """Subscription result for ``cancel.blockingSubscription``."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def res_readable(self) -> Readable[dict[str, Any]]:
        """Readable stream for receiving responses."""
        return self._inner.res_readable


class CancelImmediateStreamStreamResult:
    """Streaming result for ``cancel.immediateStream``."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def req_writable(self) -> Writable[CancelImmediateStreamInput]:
        """Writable stream for sending requests."""
        return self._inner.req_writable

    @property
    def res_readable(self) -> Readable[dict[str, Any]]:
        """Readable stream for receiving responses."""
        return self._inner.res_readable


class CancelImmediateUploadUploadResult:
    """Upload result for ``cancel.immediateUpload``."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def req_writable(self) -> Writable[CancelImmediateUploadInput]:
        """Writable stream for sending requests."""
        return self._inner.req_writable

    async def finalize(self) -> dict[str, Any]:
        """Finalize the upload and get the response."""
        return await self._inner.finalize()


class CancelImmediateSubscriptionSubscriptionResult:
    """Subscription result for ``cancel.immediateSubscription``."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def res_readable(self) -> Readable[dict[str, Any]]:
        """Readable stream for receiving responses."""
        return self._inner.res_readable


class CancelCountedStreamStreamResult:
    """Streaming result for ``cancel.countedStream``."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def req_writable(self) -> Writable[CancelCountedStreamInput]:
        """Writable stream for sending requests."""
        return self._inner.req_writable

    @property
    def res_readable(self) -> Readable[dict[str, Any]]:
        """Readable stream for receiving responses."""
        return self._inner.res_readable


class CancelClient:
    """Typed client for the ``cancel`` service."""

    def __init__(self, client: RiverClient) -> None:
        self._client = client

    async def blocking_rpc(
        self,
        init: CancelBlockingRpcInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> dict[str, Any]:
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
    ) -> CancelBlockingStreamStreamResult:
        result = self._client.stream(
            "cancel",
            "blockingStream",
            init,
            abort_signal=abort_signal,
        )
        return CancelBlockingStreamStreamResult(result)

    def blocking_upload(
        self,
        init: CancelBlockingUploadInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> CancelBlockingUploadUploadResult:
        result = self._client.upload(
            "cancel",
            "blockingUpload",
            init,
            abort_signal=abort_signal,
        )
        return CancelBlockingUploadUploadResult(result)

    def blocking_subscription(
        self,
        init: CancelBlockingSubscriptionInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> CancelBlockingSubscriptionSubscriptionResult:
        result = self._client.subscribe(
            "cancel",
            "blockingSubscription",
            init,
            abort_signal=abort_signal,
        )
        return CancelBlockingSubscriptionSubscriptionResult(result)

    async def immediate_rpc(
        self,
        init: CancelImmediateRpcInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> dict[str, Any]:
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
    ) -> CancelImmediateStreamStreamResult:
        result = self._client.stream(
            "cancel",
            "immediateStream",
            init,
            abort_signal=abort_signal,
        )
        return CancelImmediateStreamStreamResult(result)

    def immediate_upload(
        self,
        init: CancelImmediateUploadInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> CancelImmediateUploadUploadResult:
        result = self._client.upload(
            "cancel",
            "immediateUpload",
            init,
            abort_signal=abort_signal,
        )
        return CancelImmediateUploadUploadResult(result)

    def immediate_subscription(
        self,
        init: CancelImmediateSubscriptionInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> CancelImmediateSubscriptionSubscriptionResult:
        result = self._client.subscribe(
            "cancel",
            "immediateSubscription",
            init,
            abort_signal=abort_signal,
        )
        return CancelImmediateSubscriptionSubscriptionResult(result)

    def counted_stream(
        self,
        init: CancelCountedStreamInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> CancelCountedStreamStreamResult:
        result = self._client.stream(
            "cancel",
            "countedStream",
            init,
            abort_signal=abort_signal,
        )
        return CancelCountedStreamStreamResult(result)
