"""Generated client for the subscribable service."""

from __future__ import annotations

import asyncio
from typing import Any

from river.client import RiverClient
from river.streams import Readable

from ._types import (
    SubscribableAddInit,
    SubscribableValueInit,
)


class SubscribableValueSubscriptionResult:
    """Subscription result for ``subscribable.value``."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def res_readable(self) -> Readable[dict[str, Any]]:
        """Readable stream for receiving responses."""
        return self._inner.res_readable


class SubscribableClient:
    """Typed client for the ``subscribable`` service."""

    def __init__(self, client: RiverClient) -> None:
        self._client = client

    async def add(
        self,
        init: SubscribableAddInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> dict[str, Any]:
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
    ) -> SubscribableValueSubscriptionResult:
        result = self._client.subscribe(
            "subscribable",
            "value",
            init,
            abort_signal=abort_signal,
        )
        return SubscribableValueSubscriptionResult(result)
