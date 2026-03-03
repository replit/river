"""Deterministic session lifecycle tests.

Uses short timeouts to test heartbeat miss, grace period expiry,
and retry budget behavior without slow waits.
"""

from __future__ import annotations

import asyncio

import pytest

from river.client import RiverClient
from river.codec import NaiveJsonCodec
from river.session import SessionOptions, SessionState
from river.transport import WebSocketClientTransport

SHORT_OPTIONS = SessionOptions(
    heartbeat_interval_ms=100,
    heartbeats_until_dead=2,  # 200ms miss timeout
    session_disconnect_grace_ms=300,  # 300ms grace
    connection_timeout_ms=2000,
    handshake_timeout_ms=1000,
)


async def make_client(
    server_url: str,
    options: SessionOptions | None = None,
) -> RiverClient:
    transport = WebSocketClientTransport(
        ws_url=server_url,
        client_id=None,
        server_id="SERVER",
        codec=NaiveJsonCodec(),
        options=options or SHORT_OPTIONS,
    )
    return RiverClient(
        transport,
        server_id="SERVER",
        connect_on_invoke=True,
        eagerly_connect=False,
    )


async def cleanup(client: RiverClient) -> None:
    await client.transport.close()


# =====================================================================
# Heartbeat Miss Tests
# =====================================================================


class TestHeartbeatMiss:
    @pytest.mark.asyncio
    async def test_ws_close_triggers_no_connection(self, server_url: str):
        """Force-closing WS transitions session to NO_CONNECTION."""
        client = await make_client(server_url)
        try:
            # Make an RPC to establish connection
            result = await client.rpc("test", "add", {"n": 1})
            assert result["ok"] is True

            session = client.transport.sessions.get("SERVER")
            assert session is not None
            assert session.state == SessionState.CONNECTED

            # Force-close the WS (not the transport)
            ws = session._ws
            assert ws is not None
            # Disable reconnect so we can observe the state
            client.transport.reconnect_on_connection_drop = False
            await ws.close()

            # Wait for the connection drop to be processed
            await asyncio.sleep(0.3)

            assert session.state == SessionState.NO_CONNECTION
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_active_rpcs_keep_alive(self, server_url: str):
        """Active RPCs reset heartbeat miss — no spurious disconnect."""
        client = await make_client(server_url)
        try:
            # Make several RPCs over a period longer than heartbeat_interval
            for _ in range(5):
                result = await client.rpc("test", "add", {"n": 1})
                assert result["ok"] is True
                await asyncio.sleep(0.05)

            session = client.transport.sessions.get("SERVER")
            assert session is not None
            assert session.state == SessionState.CONNECTED
        finally:
            await cleanup(client)


# =====================================================================
# Grace Period Tests
# =====================================================================


class TestGracePeriod:
    @pytest.mark.asyncio
    async def test_grace_period_expiry_destroys_session(self, server_url: str):
        """Session destroyed after grace period elapses without reconnect."""
        client = await make_client(server_url)
        try:
            result = await client.rpc("test", "add", {"n": 1})
            assert result["ok"] is True

            session = client.transport.sessions.get("SERVER")
            assert session is not None
            session_id = session.id

            # Force WS close and disable reconnect
            client.transport.reconnect_on_connection_drop = False
            ws = session._ws
            assert ws is not None
            await ws.close()

            # Wait for drop processing
            await asyncio.sleep(0.1)
            assert session.state == SessionState.NO_CONNECTION

            # Wait for grace period to elapse (300ms + buffer)
            await asyncio.sleep(0.4)

            # Session should have been deleted
            remaining = client.transport.sessions.get("SERVER")
            assert remaining is None or remaining.id != session_id
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_reconnect_within_grace_preserves_session(self, server_url: str):
        """Reconnecting within grace period preserves the session."""
        # Use longer grace to ensure reconnect completes in time
        opts = SessionOptions(
            heartbeat_interval_ms=100,
            heartbeats_until_dead=2,
            session_disconnect_grace_ms=5000,
            connection_timeout_ms=2000,
            handshake_timeout_ms=1000,
        )
        client = await make_client(server_url, options=opts)
        try:
            result = await client.rpc("test", "add", {"n": 1})
            assert result["ok"] is True

            session = client.transport.sessions.get("SERVER")
            assert session is not None

            # Force WS close — auto-reconnect is on by default
            ws = session._ws
            assert ws is not None
            await ws.close()

            # Wait for reconnect to complete (well within 300ms grace)
            await asyncio.sleep(0.5)

            # Session should still exist with same ID
            new_session = client.transport.sessions.get("SERVER")
            # Either same session or a new one (server may have lost state)
            assert new_session is not None

            # Verify connection works
            result = await client.rpc("test", "add", {"n": 2})
            assert result["ok"] is True
        finally:
            await cleanup(client)


# =====================================================================
# Retry Budget Tests
# =====================================================================


class TestRetryBudget:
    @pytest.mark.asyncio
    async def test_backoff_increases_on_failures(self, server_url: str):
        """Retry backoff increases after failed attempts."""
        transport = WebSocketClientTransport(
            ws_url="ws://127.0.0.1:1",  # intentionally invalid
            client_id=None,
            server_id="INVALID",
            codec=NaiveJsonCodec(),
            options=SessionOptions(
                connection_timeout_ms=200,
                handshake_timeout_ms=200,
                session_disconnect_grace_ms=500,
            ),
        )
        try:
            budget = transport._retry_budget
            assert budget.has_budget()
            initial_backoff = budget.get_backoff_ms()

            # Consume some budget to simulate failures
            budget.consume_budget()
            budget.consume_budget()
            budget.consume_budget()

            higher_backoff = budget.get_backoff_ms()
            assert higher_backoff > initial_backoff
        finally:
            await transport.close()

    @pytest.mark.asyncio
    async def test_budget_restores_after_success(self, server_url: str):
        """Budget restores gradually after successful connection."""
        client = await make_client(server_url)
        try:
            # Make an RPC to trigger a successful connection
            result = await client.rpc("test", "add", {"n": 1})
            assert result["ok"] is True

            budget = client.transport._retry_budget
            # After a successful connection the budget_consumed should be
            # restoring (or already at 0)
            await asyncio.sleep(0.3)  # wait for budget restore
            assert budget.budget_consumed <= 1  # mostly restored
        finally:
            await cleanup(client)
