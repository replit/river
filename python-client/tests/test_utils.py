"""Test utilities for River Python client tests.

Provides event-driven waiters to replace arbitrary sleeps.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable

from river.session import SessionState
from river.transport import WebSocketClientTransport


async def wait_for(
    predicate: Callable[[], bool],
    *,
    timeout: float = 5.0,
    interval: float = 0.01,
) -> None:
    """Poll a predicate until it returns True, or raise TimeoutError.

    Args:
        predicate: Zero-arg callable returning bool.
        timeout: Max seconds to wait.
        interval: Seconds between polls.
    """
    deadline = asyncio.get_event_loop().time() + timeout
    while not predicate():
        if asyncio.get_event_loop().time() > deadline:
            raise TimeoutError(f"wait_for timed out after {timeout}s")
        await asyncio.sleep(interval)


async def wait_for_session_state(
    transport: WebSocketClientTransport,
    server_id: str,
    state: SessionState,
    *,
    timeout: float = 5.0,
) -> None:
    """Wait until the session reaches the given state."""
    await wait_for(
        lambda: (
            (s := transport.sessions.get(server_id)) is not None and s.state == state
        ),
        timeout=timeout,
    )


async def wait_for_connected(
    transport: WebSocketClientTransport,
    server_id: str = "SERVER",
    *,
    timeout: float = 5.0,
) -> None:
    """Wait until session is CONNECTED."""
    await wait_for_session_state(
        transport, server_id, SessionState.CONNECTED, timeout=timeout
    )


async def wait_for_session_gone(
    transport: WebSocketClientTransport,
    server_id: str = "SERVER",
    *,
    timeout: float = 5.0,
) -> None:
    """Wait until the session for server_id no longer exists."""
    await wait_for(
        lambda: transport.sessions.get(server_id) is None,
        timeout=timeout,
    )


async def wait_for_disconnected(
    transport: WebSocketClientTransport,
    server_id: str = "SERVER",
    *,
    timeout: float = 5.0,
) -> None:
    """Wait until session is NO_CONNECTION."""
    await wait_for_session_state(
        transport, server_id, SessionState.NO_CONNECTION, timeout=timeout
    )


async def wait_for_event(
    transport: WebSocketClientTransport,
    event_name: str,
    *,
    timeout: float = 5.0,
    predicate: Callable[[Any], bool] | None = None,
) -> Any:
    """Wait for a specific event to be dispatched on the transport.

    Args:
        transport: The transport to listen on.
        event_name: Event name (e.g. "protocolError", "sessionStatus").
        timeout: Max seconds to wait.
        predicate: Optional filter; if provided, only events matching
                   this predicate will resolve the wait.

    Returns:
        The event data.
    """
    fut: asyncio.Future[Any] = asyncio.get_event_loop().create_future()

    def handler(data: Any) -> None:
        if fut.done():
            return
        if predicate is not None and not predicate(data):
            return
        fut.set_result(data)

    transport.add_event_listener(event_name, handler)
    try:
        return await asyncio.wait_for(fut, timeout=timeout)
    finally:
        transport.remove_event_listener(event_name, handler)
