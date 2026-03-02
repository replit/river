"""Generated client for the uploadable service."""

from __future__ import annotations

import asyncio
from typing import Any

from river.client import RiverClient
from river.streams import Writable

from ._types import (
    UploadableAddMultipleInit,
    UploadableAddMultipleInput,
    UploadableAddMultipleWithPrefixInit,
    UploadableAddMultipleWithPrefixInput,
    UploadableCancellableAddInit,
    UploadableCancellableAddInput,
)


class UploadableAddMultipleUploadResult:
    """Upload result for ``uploadable.addMultiple``."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def req_writable(self) -> Writable[UploadableAddMultipleInput]:
        """Writable stream for sending requests."""
        return self._inner.req_writable

    async def finalize(self) -> dict[str, Any]:
        """Finalize the upload and get the response."""
        return await self._inner.finalize()


class UploadableAddMultipleWithPrefixUploadResult:
    """Upload result for ``uploadable.addMultipleWithPrefix``."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def req_writable(self) -> Writable[UploadableAddMultipleWithPrefixInput]:
        """Writable stream for sending requests."""
        return self._inner.req_writable

    async def finalize(self) -> dict[str, Any]:
        """Finalize the upload and get the response."""
        return await self._inner.finalize()


class UploadableCancellableAddUploadResult:
    """Upload result for ``uploadable.cancellableAdd``."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def req_writable(self) -> Writable[UploadableCancellableAddInput]:
        """Writable stream for sending requests."""
        return self._inner.req_writable

    async def finalize(self) -> dict[str, Any]:
        """Finalize the upload and get the response."""
        return await self._inner.finalize()


class UploadableClient:
    """Typed client for the ``uploadable`` service."""

    def __init__(self, client: RiverClient) -> None:
        self._client = client

    def add_multiple(
        self,
        init: UploadableAddMultipleInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> UploadableAddMultipleUploadResult:
        result = self._client.upload(
            "uploadable",
            "addMultiple",
            init,
            abort_signal=abort_signal,
        )
        return UploadableAddMultipleUploadResult(result)

    def add_multiple_with_prefix(
        self,
        init: UploadableAddMultipleWithPrefixInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> UploadableAddMultipleWithPrefixUploadResult:
        result = self._client.upload(
            "uploadable",
            "addMultipleWithPrefix",
            init,
            abort_signal=abort_signal,
        )
        return UploadableAddMultipleWithPrefixUploadResult(result)

    def cancellable_add(
        self,
        init: UploadableCancellableAddInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> UploadableCancellableAddUploadResult:
        result = self._client.upload(
            "uploadable",
            "cancellableAdd",
            init,
            abort_signal=abort_signal,
        )
        return UploadableCancellableAddUploadResult(result)
