"""Generated client for the fallible service."""

from __future__ import annotations

import asyncio
from typing import Any

from river.client import RiverClient
from river.streams import Readable, Writable

from ._types import (
    FallibleDivideInit,
    FallibleEchoInit,
    FallibleEchoInput,
)


class FallibleEchoStreamResult:
    """Streaming result for ``fallible.echo``."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    @property
    def req_writable(self) -> Writable[FallibleEchoInput]:
        """Writable stream for sending requests."""
        return self._inner.req_writable

    @property
    def res_readable(self) -> Readable[dict[str, Any]]:
        """Readable stream for receiving responses."""
        return self._inner.res_readable


class FallibleClient:
    """Typed client for the ``fallible`` service."""

    def __init__(self, client: RiverClient) -> None:
        self._client = client

    async def divide(
        self,
        init: FallibleDivideInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        return await self._client.rpc(
            "fallible",
            "divide",
            init,
            abort_signal=abort_signal,
        )

    def echo(
        self,
        init: FallibleEchoInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> FallibleEchoStreamResult:
        result = self._client.stream(
            "fallible",
            "echo",
            init,
            abort_signal=abort_signal,
        )
        return FallibleEchoStreamResult(result)
