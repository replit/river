"""Handshake metadata tests.

Tests custom handshake metadata using a dedicated test server
that requires {token: string} in the handshake.
"""

from __future__ import annotations

import asyncio

import pytest

from river.client import RiverClient
from river.codec import NaiveJsonCodec
from river.transport import WebSocketClientTransport


async def make_handshake_client(
    server_url: str,
    handshake_metadata: dict | None = None,
) -> RiverClient:
    transport = WebSocketClientTransport(
        ws_url=server_url,
        client_id=None,
        server_id="HANDSHAKE_SERVER",
        codec=NaiveJsonCodec(),
        handshake_metadata=handshake_metadata,
    )
    return RiverClient(
        transport,
        server_id="HANDSHAKE_SERVER",
        connect_on_invoke=True,
        eagerly_connect=False,
    )


async def cleanup(client: RiverClient) -> None:
    await client.transport.close()


class TestHandshake:
    @pytest.mark.asyncio
    async def test_handshake_with_valid_metadata(self, handshake_server_url: str):
        """Client with valid handshake metadata can make RPCs."""
        client = await make_handshake_client(
            handshake_server_url,
            handshake_metadata={"token": "valid-token"},
        )
        try:
            result = await client.rpc("test", "echo", {"msg": "hello"})
            assert result["ok"] is True
            assert result["payload"]["response"] == "hello"
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_handshake_with_invalid_metadata_emits_error(
        self, handshake_server_url: str
    ):
        """Client with invalid token triggers a protocolError event."""
        transport = WebSocketClientTransport(
            ws_url=handshake_server_url,
            client_id=None,
            server_id="HANDSHAKE_SERVER",
            codec=NaiveJsonCodec(),
            handshake_metadata={"token": "wrong-token"},
        )

        error_event = asyncio.Event()
        errors: list[dict] = []

        def on_error(e: dict) -> None:
            errors.append(e)
            error_event.set()

        transport.add_event_listener("protocolError", on_error)

        try:
            transport.connect("HANDSHAKE_SERVER")
            # Wait for the handshake failure event
            await asyncio.wait_for(error_event.wait(), timeout=5.0)
            assert len(errors) > 0
            assert errors[0]["type"] in ("handshake_failed", "conn_retry_exceeded")
        finally:
            await transport.close()

    @pytest.mark.asyncio
    async def test_handshake_with_missing_metadata_emits_error(
        self, handshake_server_url: str
    ):
        """Client with no metadata triggers a protocolError event."""
        transport = WebSocketClientTransport(
            ws_url=handshake_server_url,
            client_id=None,
            server_id="HANDSHAKE_SERVER",
            codec=NaiveJsonCodec(),
            handshake_metadata=None,
        )

        error_event = asyncio.Event()
        errors: list[dict] = []

        def on_error(e: dict) -> None:
            errors.append(e)
            error_event.set()

        transport.add_event_listener("protocolError", on_error)

        try:
            transport.connect("HANDSHAKE_SERVER")
            await asyncio.wait_for(error_event.wait(), timeout=5.0)
            assert len(errors) > 0
        finally:
            await transport.close()

    @pytest.mark.asyncio
    async def test_handshake_metadata_across_reconnect(self, handshake_server_url: str):
        """Metadata is resent when reconnecting."""
        client = await make_handshake_client(
            handshake_server_url,
            handshake_metadata={"token": "valid-token"},
        )
        try:
            result = await client.rpc("test", "echo", {"msg": "first"})
            assert result["ok"] is True

            session = client.transport.sessions.get("HANDSHAKE_SERVER")
            assert session is not None

            ws = session._ws
            if ws is not None:
                await ws.close()

            await asyncio.sleep(0.5)

            result = await client.rpc("test", "echo", {"msg": "after-reconnect"})
            assert result["ok"] is True
            assert result["payload"]["response"] == "after-reconnect"
        finally:
            await cleanup(client)
