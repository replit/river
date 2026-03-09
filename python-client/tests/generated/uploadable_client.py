"""Generated client for the uploadable service."""

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
    UploadableAddMultipleInit,
    UploadableAddMultipleInput,
    UploadableAddMultipleOutput,
    UploadableAddMultipleWithPrefixInit,
    UploadableAddMultipleWithPrefixInput,
    UploadableAddMultipleWithPrefixOutput,
    UploadableCancellableAddInit,
    UploadableCancellableAddInput,
    UploadableCancellableAddOutput,
)

from ._errors import ProtocolError


class UploadableClient:
    """Typed client for the ``uploadable`` service."""

    def __init__(self, client: RiverClient) -> None:
        self._client = client

    def add_multiple(
        self,
        init: UploadableAddMultipleInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> UploadResult[UploadableAddMultipleInput, OkResult[UploadableAddMultipleOutput] | ErrResult[ProtocolError]]:
        return self._client.upload(
            "uploadable",
            "addMultiple",
            init,
            abort_signal=abort_signal,
        )

    def add_multiple_with_prefix(
        self,
        init: UploadableAddMultipleWithPrefixInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> UploadResult[UploadableAddMultipleWithPrefixInput, OkResult[UploadableAddMultipleWithPrefixOutput] | ErrResult[ProtocolError]]:
        return self._client.upload(
            "uploadable",
            "addMultipleWithPrefix",
            init,
            abort_signal=abort_signal,
        )

    def cancellable_add(
        self,
        init: UploadableCancellableAddInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> UploadResult[UploadableCancellableAddInput, OkResult[UploadableCancellableAddOutput] | ErrResult[ProtocolError]]:
        return self._client.upload(
            "uploadable",
            "cancellableAdd",
            init,
            abort_signal=abort_signal,
        )
