"""Generated client for the test service."""

from __future__ import annotations

import asyncio

from river.client import (
    ErrResult,
    OkResult,
    RiverClient,
)

from ._errors import ProtocolError
from ._types import (
    TestEchoInit,
    TestEchoOutput,
)


class TestClient:
    """Typed client for the ``test`` service."""

    def __init__(self, client: RiverClient) -> None:
        self._client = client

    async def echo(
        self,
        init: TestEchoInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> OkResult[TestEchoOutput] | ErrResult[ProtocolError]:
        return await self._client.rpc(
            "test",
            "echo",
            init,
            abort_signal=abort_signal,
        )
