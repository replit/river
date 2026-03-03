"""Generated client for the fallible service."""

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
    FallibleDivideErrorDivByZero,
    FallibleDivideErrorInfinity,
    FallibleDivideInit,
    FallibleDivideOutput,
    FallibleEchoError,
    FallibleEchoInit,
    FallibleEchoInput,
    FallibleEchoOutput,
)

from ._errors import ProtocolError


class FallibleClient:
    """Typed client for the ``fallible`` service."""

    def __init__(self, client: RiverClient) -> None:
        self._client = client

    async def divide(
        self,
        init: FallibleDivideInit,
        *,
        abort_signal: asyncio.Event | None = None,
    ) -> OkResult[FallibleDivideOutput] | ErrResult[FallibleDivideErrorDivByZero | FallibleDivideErrorInfinity | ProtocolError]:
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
    ) -> StreamResult[FallibleEchoInput]:
        return self._client.stream(
            "fallible",
            "echo",
            init,
            abort_signal=abort_signal,
        )
