"""Generated client for the ordering service."""

from __future__ import annotations

import asyncio
from typing import Any

from river.client import RiverClient

from ._types import (
    OrderingAddInit,
    OrderingGetAllInit,
)


class OrderingClient:
    """Typed client for the ``ordering`` service."""

    def __init__(self, client: RiverClient) -> None:
        self._client = client

    async def add(
        self,
        init: OrderingAddInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        return await self._client.rpc(
            "ordering",
            "add",
            init,
            abort_signal=abort_signal,
        )

    async def get_all(
        self,
        init: OrderingGetAllInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        return await self._client.rpc(
            "ordering",
            "getAll",
            init,
            abort_signal=abort_signal,
        )
