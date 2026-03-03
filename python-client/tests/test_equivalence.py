"""Cross-codec parametrized equivalence tests.

Every test in this module runs against both NaiveJsonCodec and BinaryCodec,
proving that both codecs produce identical behavior against the TS server.
Each codec is paired with a matching server (JSON or binary).
"""

from __future__ import annotations

import asyncio

import pytest

from river.client import RiverClient
from river.codec import Codec
from river.session import SessionOptions
from river.transport import WebSocketClientTransport

# -- helpers --


async def make_client(
    url: str, codec: Codec, options: SessionOptions | None = None
) -> RiverClient:
    transport = WebSocketClientTransport(
        ws_url=url,
        client_id=None,
        server_id="SERVER",
        codec=codec,
        options=options,
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
# RPC Equivalence
# =====================================================================


class TestRpcEquivalence:
    @pytest.mark.asyncio
    async def test_basic_rpc(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            result = await client.rpc("test", "add", {"n": 3})
            assert result["ok"] is True
            # test.add uses a global accumulator, so just verify it returns a number
            assert isinstance(result["payload"]["result"], (int, float))
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_fallible_rpc_success(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            result = await client.rpc("fallible", "divide", {"a": 10, "b": 2})
            assert result["ok"] is True
            assert result["payload"]["result"] == 5.0
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_fallible_rpc_div_by_zero(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            result = await client.rpc("fallible", "divide", {"a": 10, "b": 0})
            assert result["ok"] is False
            assert result["payload"]["code"] == "DIV_BY_ZERO"
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_concurrent_rpcs(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            tasks = [client.rpc("ordering", "add", {"n": i}) for i in range(10)]
            results = await asyncio.gather(*tasks)
            for i, result in enumerate(results):
                assert result["ok"] is True
                assert result["payload"]["n"] == i
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_rpc_on_closed_transport(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        await client.transport.close()

        result = await client.rpc("test", "add", {"n": 1})
        assert result["ok"] is False
        assert result["payload"]["code"] == "UNEXPECTED_DISCONNECT"

    @pytest.mark.asyncio
    async def test_binary_echo(self, codec_and_url: tuple[Codec, str]):
        """Binary roundtrip — data passes through codec correctly."""
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            test_data = b"\x00\x01\x02\xff\xfe\xfd"
            result = await client.rpc("test", "echoBinary", {"data": test_data})
            assert result["ok"] is True
            assert result["payload"]["length"] == len(test_data)
            returned = result["payload"]["data"]
            if isinstance(returned, (bytes, bytearray)):
                assert bytes(returned) == test_data
        finally:
            await cleanup(client)


# =====================================================================
# Stream Equivalence
# =====================================================================


class TestStreamEquivalence:
    @pytest.mark.asyncio
    async def test_basic_echo_stream(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            stream = client.stream("test", "echo", {})
            stream.req_writable.write({"msg": "hello", "ignore": False})
            stream.req_writable.write({"msg": "world", "ignore": False})
            stream.req_writable.write({"msg": "skip", "ignore": True})
            stream.req_writable.write({"msg": "end", "ignore": False})
            stream.req_writable.close()

            results = await stream.res_readable.collect()
            assert len(results) == 3
            assert results[0]["payload"]["response"] == "hello"
            assert results[1]["payload"]["response"] == "world"
            assert results[2]["payload"]["response"] == "end"
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_stream_with_init_message(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            stream = client.stream("test", "echoWithPrefix", {"prefix": "pfx"})
            stream.req_writable.write({"msg": "hello", "ignore": False})
            stream.req_writable.write({"msg": "world", "ignore": False})
            stream.req_writable.close()

            results = await stream.res_readable.collect()
            assert len(results) == 2
            assert results[0]["payload"]["response"] == "pfx hello"
            assert results[1]["payload"]["response"] == "pfx world"
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_empty_stream(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            stream = client.stream("test", "echo", {})
            stream.req_writable.close()
            results = await stream.res_readable.collect()
            assert len(results) == 0
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_fallible_stream_ok(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            stream = client.stream("fallible", "echo", {})
            stream.req_writable.write(
                {"msg": "hi", "throwResult": False, "throwError": False}
            )
            done, msg = await stream.res_readable.next()
            assert not done
            assert msg["ok"] is True
            assert msg["payload"]["response"] == "hi"
            stream.req_writable.close()
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_fallible_stream_err(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            stream = client.stream("fallible", "echo", {})
            stream.req_writable.write(
                {"msg": "fail", "throwResult": True, "throwError": False}
            )
            done, msg = await stream.res_readable.next()
            assert not done
            assert msg["ok"] is False
            assert msg["payload"]["code"] == "STREAM_ERROR"
            stream.req_writable.close()
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_fallible_stream_uncaught(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            stream = client.stream("fallible", "echo", {})
            stream.req_writable.write(
                {"msg": "throw", "throwResult": False, "throwError": True}
            )
            done, msg = await stream.res_readable.next()
            assert not done
            assert msg["ok"] is False
            assert msg["payload"]["code"] == "UNCAUGHT_ERROR"
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_concurrent_streams(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            streams = []
            for _ in range(5):
                s = client.stream("test", "echo", {})
                streams.append(s)

            for i, s in enumerate(streams):
                s.req_writable.write({"msg": f"msg-{i}", "ignore": False})
                s.req_writable.close()

            for i, s in enumerate(streams):
                results = await s.res_readable.collect()
                assert len(results) == 1
                assert results[0]["payload"]["response"] == f"msg-{i}"
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_stream_on_closed_transport(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        await client.transport.close()

        stream = client.stream("test", "echo", {})
        done, msg = await stream.res_readable.next()
        assert not done
        assert msg["ok"] is False
        assert msg["payload"]["code"] == "UNEXPECTED_DISCONNECT"


# =====================================================================
# Upload Equivalence
# =====================================================================


class TestUploadEquivalence:
    @pytest.mark.asyncio
    async def test_basic_upload(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            upload = client.upload("uploadable", "addMultiple", {})
            upload.req_writable.write({"n": 1})
            upload.req_writable.write({"n": 2})
            upload.req_writable.close()

            result = await upload.finalize()
            assert result["ok"] is True
            assert result["payload"]["result"] == 3
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_empty_upload(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            upload = client.upload("uploadable", "addMultiple", {})
            upload.req_writable.close()

            result = await upload.finalize()
            assert result["ok"] is True
            assert result["payload"]["result"] == 0
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_upload_with_init_message(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            upload = client.upload(
                "uploadable", "addMultipleWithPrefix", {"prefix": "total"}
            )
            upload.req_writable.write({"n": 5})
            upload.req_writable.write({"n": 7})
            upload.req_writable.close()

            result = await upload.finalize()
            assert result["ok"] is True
            assert result["payload"]["result"] == "total 12"
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_upload_server_cancel(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            upload = client.upload("uploadable", "cancellableAdd", {})
            upload.req_writable.write({"n": 9})
            upload.req_writable.write({"n": 1})

            result = await upload.finalize()
            assert result["ok"] is False
            assert result["payload"]["code"] == "CANCEL"
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_upload_finalize_auto_closes(self, codec_and_url: tuple[Codec, str]):
        """finalize() auto-closes writable if not yet closed."""
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            upload = client.upload("uploadable", "addMultiple", {})
            upload.req_writable.write({"n": 4})
            result = await upload.finalize()
            assert result["ok"] is True
            assert result["payload"]["result"] == 4
            assert not upload.req_writable.is_writable()
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_upload_on_closed_transport(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        await client.transport.close()

        upload = client.upload("uploadable", "addMultiple", {})
        assert not upload.req_writable.is_writable()
        result = await upload.finalize()
        assert result["ok"] is False
        assert result["payload"]["code"] == "UNEXPECTED_DISCONNECT"


# =====================================================================
# Subscription Equivalence
# =====================================================================


class TestSubscriptionEquivalence:
    @pytest.mark.asyncio
    async def test_subscription_initial_and_update(
        self, codec_and_url: tuple[Codec, str]
    ):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            sub = client.subscribe("subscribable", "value", {})

            done, msg = await sub.res_readable.next()
            assert not done
            assert msg["ok"] is True
            initial_count = msg["payload"]["count"]

            add_result = await client.rpc("subscribable", "add", {"n": 1})
            assert add_result["ok"] is True

            done, msg = await sub.res_readable.next()
            assert not done
            assert msg["ok"] is True
            assert msg["payload"]["count"] == initial_count + 1
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_subscription_abort(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            abort_evt = asyncio.Event()
            sub = client.subscribe("subscribable", "value", {}, abort_signal=abort_evt)

            done, msg = await sub.res_readable.next()
            assert not done
            assert msg["ok"] is True

            abort_evt.set()
            await asyncio.sleep(0.05)

            done, msg = await sub.res_readable.next()
            assert not done
            assert msg["ok"] is False
            assert msg["payload"]["code"] == "CANCEL"
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_subscription_on_closed_transport(
        self, codec_and_url: tuple[Codec, str]
    ):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        await client.transport.close()

        sub = client.subscribe("subscribable", "value", {})
        done, msg = await sub.res_readable.next()
        assert not done
        assert msg["ok"] is False
        assert msg["payload"]["code"] == "UNEXPECTED_DISCONNECT"


# =====================================================================
# Cancellation Equivalence
# =====================================================================


class TestCancellationEquivalence:
    @pytest.mark.asyncio
    async def test_cancel_rpc(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            abort_evt = asyncio.Event()

            async def trigger():
                await asyncio.sleep(0.2)
                abort_evt.set()

            asyncio.ensure_future(trigger())
            result = await client.rpc(
                "cancel", "blockingRpc", {}, abort_signal=abort_evt
            )
            assert result["ok"] is False
            assert result["payload"]["code"] == "CANCEL"
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_cancel_stream(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            abort_evt = asyncio.Event()
            stream = client.stream(
                "cancel", "blockingStream", {}, abort_signal=abort_evt
            )
            await asyncio.sleep(0.2)
            abort_evt.set()
            await asyncio.sleep(0)

            results = await stream.res_readable.collect()
            assert len(results) == 1
            assert results[0]["ok"] is False
            assert results[0]["payload"]["code"] == "CANCEL"
            assert not stream.req_writable.is_writable()
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_cancel_upload(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            abort_evt = asyncio.Event()
            upload = client.upload(
                "cancel", "blockingUpload", {}, abort_signal=abort_evt
            )
            await asyncio.sleep(0.2)
            abort_evt.set()

            result = await upload.finalize()
            assert result["ok"] is False
            assert result["payload"]["code"] == "CANCEL"
            assert not upload.req_writable.is_writable()
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_cancel_subscription(self, codec_and_url: tuple[Codec, str]):
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            abort_evt = asyncio.Event()
            sub = client.subscribe(
                "cancel", "blockingSubscription", {}, abort_signal=abort_evt
            )
            await asyncio.sleep(0.2)
            abort_evt.set()
            await asyncio.sleep(0)

            done, msg = await sub.res_readable.next()
            assert not done
            assert msg["ok"] is False
            assert msg["payload"]["code"] == "CANCEL"
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_cancel_after_completion_is_noop(
        self, codec_and_url: tuple[Codec, str]
    ):
        """Cancelling after the procedure completed doesn't crash."""
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            abort_evt = asyncio.Event()
            result = await client.rpc(
                "cancel", "immediateRpc", {}, abort_signal=abort_evt
            )
            assert result["ok"] is True
            assert result["payload"]["done"] is True

            abort_evt.set()
            await asyncio.sleep(0.05)
        finally:
            await cleanup(client)

    @pytest.mark.asyncio
    async def test_cancel_after_transport_close_is_safe(
        self, codec_and_url: tuple[Codec, str]
    ):
        """Cancelling after transport close doesn't crash."""
        codec, url = codec_and_url
        client = await make_client(url, codec)
        abort_evt = asyncio.Event()
        await client.rpc("cancel", "immediateRpc", {}, abort_signal=abort_evt)
        await client.transport.close()

        abort_evt.set()
        await asyncio.sleep(0.05)


# =====================================================================
# Disconnect Equivalence
# =====================================================================


class TestDisconnectEquivalence:
    @pytest.mark.asyncio
    async def test_all_proc_types_on_closed_transport(
        self, codec_and_url: tuple[Codec, str]
    ):
        """All 4 procedure types return UNEXPECTED_DISCONNECT on closed transport."""
        codec, url = codec_and_url
        client = await make_client(url, codec)
        await client.transport.close()

        result = await client.rpc("test", "add", {"n": 1})
        assert result["ok"] is False
        assert result["payload"]["code"] == "UNEXPECTED_DISCONNECT"

        stream = client.stream("test", "echo", {})
        done, msg = await stream.res_readable.next()
        assert msg["ok"] is False
        assert msg["payload"]["code"] == "UNEXPECTED_DISCONNECT"

        upload = client.upload("uploadable", "addMultiple", {})
        uresult = await upload.finalize()
        assert uresult["ok"] is False
        assert uresult["payload"]["code"] == "UNEXPECTED_DISCONNECT"

        sub = client.subscribe("subscribable", "value", {})
        done, msg = await sub.res_readable.next()
        assert msg["ok"] is False
        assert msg["payload"]["code"] == "UNEXPECTED_DISCONNECT"

    @pytest.mark.asyncio
    async def test_mid_stream_disconnect(self, codec_and_url: tuple[Codec, str]):
        """Force-closing the WS mid-stream produces disconnect error."""
        codec, url = codec_and_url
        short_opts = SessionOptions(session_disconnect_grace_ms=200)
        client = await make_client(url, codec, options=short_opts)
        try:
            # Disable reconnect so session gets destroyed
            client.transport.reconnect_on_connection_drop = False

            stream = client.stream("test", "echo", {})
            stream.req_writable.write({"msg": "before", "ignore": False})

            done, msg = await stream.res_readable.next()
            assert not done
            assert msg["ok"] is True
            assert msg["payload"]["response"] == "before"

            session = client.transport.sessions.get("SERVER")
            assert session is not None
            if session._ws is not None:
                await session._ws.close()

            # Wait for short grace period to expire
            await asyncio.sleep(0.4)

            # Session destroyed → stream gets UNEXPECTED_DISCONNECT
            done, msg = await stream.res_readable.next()
            if not done:
                assert msg["ok"] is False
                assert msg["payload"]["code"] == "UNEXPECTED_DISCONNECT"
        finally:
            await cleanup(client)


# =====================================================================
# Ordering Equivalence
# =====================================================================


class TestOrderingEquivalence:
    @pytest.mark.asyncio
    async def test_concurrent_rpc_ordering(self, codec_and_url: tuple[Codec, str]):
        """N concurrent RPCs to ordering service all arrive, responses match."""
        codec, url = codec_and_url
        client = await make_client(url, codec)
        try:
            n = 20
            tasks = [client.rpc("ordering", "add", {"n": i}) for i in range(n)]
            results = await asyncio.gather(*tasks)

            returned_ns = []
            for r in results:
                assert r["ok"] is True
                returned_ns.append(r["payload"]["n"])

            assert sorted(returned_ns) == list(range(n))
        finally:
            await cleanup(client)
