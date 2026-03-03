"""Generated client for the subscribable service."""

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
    SubscribableAddInit,
    SubscribableAddOutput,
    SubscribableValueInit,
    SubscribableValueOutput,
)

from ._errors import ProtocolError


class SubscribableClient:
    """Typed client for the ``subscribable`` service."""

    def __init__(self, client: RiverClient) -> None:
        self._client = client

    async def add(
        self,
        init: SubscribableAddInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> OkResult[SubscribableAddOutput] | ErrResult[ProtocolError]:
        return await self._client.rpc(
            "subscribable",
            "add",
            init,
            abort_signal=abort_signal,
        )

    def value(
        self,
        init: SubscribableValueInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> SubscriptionResult:
        return self._client.subscribe(
            "subscribable",
            "value",
            init,
            abort_signal=abort_signal,
        )
