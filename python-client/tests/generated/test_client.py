"""Generated client for the test service."""

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
    TestAddInit,
    TestAddOutput,
    TestEchoBinaryInit,
    TestEchoBinaryOutput,
    TestEchoInit,
    TestEchoInput,
    TestEchoOutput,
    TestEchoWithPrefixInit,
    TestEchoWithPrefixInput,
    TestEchoWithPrefixOutput,
)

from ._errors import ProtocolError


class TestClient:
    """Typed client for the ``test`` service."""

    def __init__(self, client: RiverClient) -> None:
        self._client = client

    async def add(
        self,
        init: TestAddInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> OkResult[TestAddOutput] | ErrResult[ProtocolError]:
        return await self._client.rpc(
            "test",
            "add",
            init,
            abort_signal=abort_signal,
        )

    def echo(
        self,
        init: TestEchoInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> StreamResult[TestEchoInput]:
        return self._client.stream(
            "test",
            "echo",
            init,
            abort_signal=abort_signal,
        )

    def echo_with_prefix(
        self,
        init: TestEchoWithPrefixInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> StreamResult[TestEchoWithPrefixInput]:
        return self._client.stream(
            "test",
            "echoWithPrefix",
            init,
            abort_signal=abort_signal,
        )

    async def echo_binary(
        self,
        init: TestEchoBinaryInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> OkResult[TestEchoBinaryOutput] | ErrResult[ProtocolError]:
        return await self._client.rpc(
            "test",
            "echoBinary",
            init,
            abort_signal=abort_signal,
        )
