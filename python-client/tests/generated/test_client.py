"""Generated client for the test service."""

from __future__ import annotations

import asyncio
from typing import Any

from river.client import RiverClient
from river.streams import Readable, Writable

from ._types import (
    TestAddInit,
    TestEchoBinaryInit,
    TestEchoInit,
    TestEchoInput,
    TestEchoWithPrefixInit,
    TestEchoWithPrefixInput,
)


class TestEchoStreamResult:
    """Streaming result for ``test.echo``."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def req_writable(self) -> Writable[TestEchoInput]:
        """Writable stream for sending requests."""
        return self._inner.req_writable

    @property
    def res_readable(self) -> Readable[dict[str, Any]]:
        """Readable stream for receiving responses."""
        return self._inner.res_readable


class TestEchoWithPrefixStreamResult:
    """Streaming result for ``test.echoWithPrefix``."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def req_writable(self) -> Writable[TestEchoWithPrefixInput]:
        """Writable stream for sending requests."""
        return self._inner.req_writable

    @property
    def res_readable(self) -> Readable[dict[str, Any]]:
        """Readable stream for receiving responses."""
        return self._inner.res_readable


class TestClient:
    """Typed client for the ``test`` service."""

    def __init__(self, client: RiverClient) -> None:
        self._client = client

    async def add(
        self,
        init: TestAddInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> dict[str, Any]:
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
    ) -> TestEchoStreamResult:
        result = self._client.stream(
            "test",
            "echo",
            init,
            abort_signal=abort_signal,
        )
        return TestEchoStreamResult(result)

    def echo_with_prefix(
        self,
        init: TestEchoWithPrefixInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> TestEchoWithPrefixStreamResult:
        result = self._client.stream(
            "test",
            "echoWithPrefix",
            init,
            abort_signal=abort_signal,
        )
        return TestEchoWithPrefixStreamResult(result)

    async def echo_binary(
        self,
        init: TestEchoBinaryInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        return await self._client.rpc(
            "test",
            "echoBinary",
            init,
            abort_signal=abort_signal,
        )
