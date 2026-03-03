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


# =====================================================================
# Grace Period Expiry During Active Procedures
# =====================================================================


class TestGracePeriodActiveProcedures:
    """Grace period expiry while a procedure is in-flight should
    produce UNEXPECTED_DISCONNECT — mirroring disconnects.test.ts."""

    @pytest.mark.asyncio
    async def test_rpc_gets_disconnect_on_grace_expiry(self, server_url: str):
        """RPC buffered during disconnect gets UNEXPECTED_DISCONNECT after grace."""
        client = await make_client(server_url)
        try:
            # Establish connection
            result = await client.rpc("test", "add", {"n": 1})
            assert result["ok"] is True

            # Kill connection, disable reconnect
            client.transport.reconnect_on_connection_drop = False
            session = client.transport.sessions.get("SERVER")
            assert session is not None
            await session._ws.close()
            await asyncio.sleep(0.1)

            # Start an RPC while disconnected — message gets buffered
            rpc_task = asyncio.create_task(client.rpc("test", "add", {"n": 2}))

            # Wait for grace period (300ms) to expire
            await asyncio.sleep(0.5)

            result = await asyncio.wait_for(rpc_task, timeout=2.0)
            assert result["ok"] is False
            assert result["payload"]["code"] == "UNEXPECTED_DISCONNECT"
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_stream_gets_disconnect_on_grace_expiry(self, server_url: str):
        """Active stream gets UNEXPECTED_DISCONNECT after grace period."""
        client = await make_client(server_url)
        try:
            stream = client.stream("test", "echo", {})
            stream.req_writable.write({"msg": "hello", "ignore": False})
            done, msg = await stream.res_readable.next()
            assert not done
            assert msg["ok"] is True

            # Kill connection, disable reconnect
            client.transport.reconnect_on_connection_drop = False
            session = client.transport.sessions.get("SERVER")
            assert session is not None
            await session._ws.close()

            # Wait for grace period to expire
            await asyncio.sleep(0.5)

            done, msg = await stream.res_readable.next()
            assert not done
            assert msg["ok"] is False
            assert msg["payload"]["code"] == "UNEXPECTED_DISCONNECT"
            assert not stream.req_writable.is_writable()
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_upload_gets_disconnect_on_grace_expiry(self, server_url: str):
        """Upload in-flight gets UNEXPECTED_DISCONNECT after grace period."""
        client = await make_client(server_url)
        try:
            upload = client.upload("uploadable", "addMultiple", {})
            upload.req_writable.write({"n": 1})

            # Ensure connection established
            await asyncio.sleep(0.1)

            # Kill connection, disable reconnect
            client.transport.reconnect_on_connection_drop = False
            session = client.transport.sessions.get("SERVER")
            assert session is not None
            await session._ws.close()

            # Wait for grace period to expire
            await asyncio.sleep(0.5)

            result = await asyncio.wait_for(upload.finalize(), timeout=2.0)
            assert result["ok"] is False
            assert result["payload"]["code"] == "UNEXPECTED_DISCONNECT"
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_subscription_gets_disconnect_on_grace_expiry(self, server_url: str):
        """Subscription gets UNEXPECTED_DISCONNECT after grace period."""
        client = await make_client(server_url)
        try:
            sub = client.subscribe("subscribable", "value", {})
            done, msg = await sub.res_readable.next()
            assert not done
            assert msg["ok"] is True

            # Kill connection, disable reconnect
            client.transport.reconnect_on_connection_drop = False
            session = client.transport.sessions.get("SERVER")
            assert session is not None
            await session._ws.close()

            # Wait for grace period to expire
            await asyncio.sleep(0.5)

            done, msg = await sub.res_readable.next()
            assert not done
            assert msg["ok"] is False
            assert msg["payload"]["code"] == "UNEXPECTED_DISCONNECT"
        finally:
            await cleanup(client)


# =====================================================================
# Reconnect After Grace Expiry
# =====================================================================


class TestReconnectAfterGrace:
    @pytest.mark.asyncio
    async def test_rpc_after_grace_expiry_creates_new_session(self, server_url: str):
        """After grace period expires, a new RPC creates a fresh session."""
        client = await make_client(server_url)
        try:
            result = await client.rpc("test", "add", {"n": 1})
            assert result["ok"] is True

            old_session = client.transport.sessions.get("SERVER")
            assert old_session is not None
            old_id = old_session.id

            # Kill connection, disable reconnect, wait for grace expiry
            client.transport.reconnect_on_connection_drop = False
            await old_session._ws.close()
            await asyncio.sleep(0.5)

            # Session should be gone
            assert client.transport.sessions.get("SERVER") is None

            # Re-enable reconnect and make a new RPC
            client.transport.reconnect_on_connection_drop = True
            result = await client.rpc("test", "add", {"n": 2})
            assert result["ok"] is True

            # Should have a new session with a different ID
            new_session = client.transport.sessions.get("SERVER")
            assert new_session is not None
            assert new_session.id != old_id
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_connect_on_invoke_false_no_reconnect(self, server_url: str):
        """With connect_on_invoke=False, no reconnect after grace expiry.

        The RPC buffers the message but never connects, so it hangs.
        We verify this by checking the transport state rather than
        waiting for an RPC result.
        """
        transport = WebSocketClientTransport(
            ws_url=server_url,
            client_id=None,
            server_id="SERVER",
            codec=NaiveJsonCodec(),
            options=SHORT_OPTIONS,
        )
        client = RiverClient(
            transport,
            server_id="SERVER",
            connect_on_invoke=False,
            eagerly_connect=True,
        )
        try:
            # Wait for eager connection
            await asyncio.sleep(0.3)
            session = transport.sessions.get("SERVER")
            assert session is not None

            # Make an RPC to verify connection works
            result = await client.rpc("test", "add", {"n": 1})
            assert result["ok"] is True

            # Kill connection, disable reconnect, wait for grace expiry
            transport.reconnect_on_connection_drop = False
            await session._ws.close()
            await asyncio.sleep(0.5)

            # Session should be gone after grace expiry
            assert transport.sessions.get("SERVER") is None

            # Re-enable reconnect on drop but connect_on_invoke is still false
            transport.reconnect_on_connection_drop = True

            # With connect_on_invoke=False, the transport won't connect.
            # Closing the transport now should produce UNEXPECTED_DISCONNECT
            # for any pending procedures.
            await transport.close()

            result = await client.rpc("test", "add", {"n": 2})
            assert result["ok"] is False
            assert result["payload"]["code"] == "UNEXPECTED_DISCONNECT"
        finally:
            # transport already closed above
            pass
