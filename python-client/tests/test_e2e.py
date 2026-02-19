"""End-to-end tests for the River Python client.

Tests the Python client against the TypeScript test server, covering
all four procedure types and core protocol behavior.
"""

from __future__ import annotations

import asyncio
import pytest

from river.client import RiverClient
from river.transport import WebSocketClientTransport
from river.codec import NaiveJsonCodec


# -- helpers --


async def make_client(server_url: str, **kwargs) -> RiverClient:
    """Create a connected RiverClient."""
    transport = WebSocketClientTransport(
        ws_url=server_url,
        client_id=None,  # auto-generate
        server_id="SERVER",
        codec=NaiveJsonCodec(),
        connect_on_invoke=kwargs.get("connect_on_invoke", True),
        eagerly_connect=kwargs.get("eagerly_connect", False),
    )
    return RiverClient(transport, server_id="SERVER")


async def cleanup_client(client: RiverClient) -> None:
    await client.transport.close()


# =====================================================================
# RPC Tests
# =====================================================================


class TestRpc:
    @pytest.mark.asyncio
    async def test_rpc_basic(self, server_url: str):
        """Basic RPC call returns correct result."""
        client = await make_client(server_url)
        try:
            result = await client.rpc("test", "add", {"n": 3})
            assert result["ok"] is True
            assert result["payload"]["result"] == 3
        finally:
            await cleanup_client(client)

    @pytest.mark.asyncio
    async def test_fallible_rpc_success(self, server_url: str):
        """Fallible RPC returns Ok on valid input."""
        client = await make_client(server_url)
        try:
            result = await client.rpc("fallible", "divide", {"a": 10, "b": 2})
            assert result["ok"] is True
            assert result["payload"]["result"] == 5.0
        finally:
            await cleanup_client(client)

    @pytest.mark.asyncio
    async def test_fallible_rpc_error(self, server_url: str):
        """Fallible RPC returns Err with correct error code."""
        client = await make_client(server_url)
        try:
            result = await client.rpc("fallible", "divide", {"a": 10, "b": 0})
            assert result["ok"] is False
            assert result["payload"]["code"] == "DIV_BY_ZERO"
        finally:
            await cleanup_client(client)

    @pytest.mark.asyncio
    async def test_concurrent_rpcs(self, server_url: str):
        """Multiple concurrent RPCs all complete correctly."""
        client = await make_client(server_url)
        try:
            tasks = [
                client.rpc("ordering", "add", {"n": i}) for i in range(10)
            ]
            results = await asyncio.gather(*tasks)
            for i, result in enumerate(results):
                assert result["ok"] is True
                assert result["payload"]["n"] == i
        finally:
            await cleanup_client(client)


# =====================================================================
# Stream Tests
# =====================================================================


class TestStream:
    @pytest.mark.asyncio
    async def test_stream_basic(self, server_url: str):
        """Stream echoes messages correctly, skipping ignored ones."""
        client = await make_client(server_url)
        try:
            stream = client.stream("test", "echo", {})

            # Write messages
            stream.req_writable.write({"msg": "hello", "ignore": False})
            stream.req_writable.write({"msg": "world", "ignore": False})
            stream.req_writable.write({"msg": "skip", "ignore": True})
            stream.req_writable.write({"msg": "end", "ignore": False})
            stream.req_writable.close()

            # Read responses
            results = []
            async for msg in stream.res_readable:
                results.append(msg)

            assert len(results) == 3
            assert results[0]["ok"] is True
            assert results[0]["payload"]["response"] == "hello"
            assert results[1]["payload"]["response"] == "world"
            assert results[2]["payload"]["response"] == "end"
        finally:
            await cleanup_client(client)

    @pytest.mark.asyncio
    async def test_stream_empty(self, server_url: str):
        """Stream with immediate close returns no results."""
        client = await make_client(server_url)
        try:
            stream = client.stream("test", "echo", {})
            stream.req_writable.close()

            results = await stream.res_readable.collect()
            assert len(results) == 0
        finally:
            await cleanup_client(client)

    @pytest.mark.asyncio
    async def test_stream_with_init_message(self, server_url: str):
        """Stream handler receives the init message."""
        client = await make_client(server_url)
        try:
            stream = client.stream(
                "test", "echoWithPrefix", {"prefix": "test"}
            )
            stream.req_writable.write({"msg": "hello", "ignore": False})
            stream.req_writable.write({"msg": "world", "ignore": False})
            stream.req_writable.close()

            results = await stream.res_readable.collect()
            assert len(results) == 2
            assert results[0]["payload"]["response"] == "test hello"
            assert results[1]["payload"]["response"] == "test world"
        finally:
            await cleanup_client(client)

    @pytest.mark.asyncio
    async def test_fallible_stream(self, server_url: str):
        """Stream correctly propagates both Ok and Err results."""
        client = await make_client(server_url)
        try:
            stream = client.stream("fallible", "echo", {})

            # Normal message
            stream.req_writable.write(
                {"msg": "hello", "throwResult": False, "throwError": False}
            )
            done, msg = await stream.res_readable.next()
            assert not done
            assert msg["ok"] is True
            assert msg["payload"]["response"] == "hello"

            # Error result (service-level error)
            stream.req_writable.write(
                {"msg": "fail", "throwResult": True, "throwError": False}
            )
            done, msg = await stream.res_readable.next()
            assert not done
            assert msg["ok"] is False
            assert msg["payload"]["code"] == "STREAM_ERROR"

            # Uncaught error (causes stream cancel)
            stream.req_writable.write(
                {"msg": "throw", "throwResult": False, "throwError": True}
            )
            done, msg = await stream.res_readable.next()
            assert not done
            assert msg["ok"] is False
            assert msg["payload"]["code"] == "UNCAUGHT_ERROR"
        finally:
            await cleanup_client(client)

    @pytest.mark.asyncio
    async def test_concurrent_streams(self, server_url: str):
        """Multiple concurrent streams work independently."""
        client = await make_client(server_url)
        try:
            streams = []
            for _ in range(5):
                s = client.stream("test", "echo", {})
                streams.append(s)

            # Write to each stream
            for i, s in enumerate(streams):
                s.req_writable.write({"msg": f"msg-{i}", "ignore": False})
                s.req_writable.close()

            # Read from each stream
            for i, s in enumerate(streams):
                results = await s.res_readable.collect()
                assert len(results) == 1
                assert results[0]["payload"]["response"] == f"msg-{i}"
        finally:
            await cleanup_client(client)


# =====================================================================
# Subscription Tests
# =====================================================================


class TestSubscription:
    @pytest.mark.asyncio
    async def test_subscription_basic(self, server_url: str):
        """Subscription receives initial value and updates."""
        client = await make_client(server_url)
        try:
            sub = client.subscribe("subscribable", "value", {})

            # Read initial value
            done, msg = await sub.res_readable.next()
            assert not done
            assert msg["ok"] is True
            initial_count = msg["payload"]["count"]

            # Trigger an update
            add_result = await client.rpc("subscribable", "add", {"n": 1})
            assert add_result["ok"] is True

            # Read updated value
            done, msg = await sub.res_readable.next()
            assert not done
            assert msg["ok"] is True
            assert msg["payload"]["count"] == initial_count + 1
        finally:
            await cleanup_client(client)


# =====================================================================
# Upload Tests
# =====================================================================


class TestUpload:
    @pytest.mark.asyncio
    async def test_upload_basic(self, server_url: str):
        """Upload sums multiple values correctly."""
        client = await make_client(server_url)
        try:
            upload = client.upload("uploadable", "addMultiple", {})
            upload.req_writable.write({"n": 1})
            upload.req_writable.write({"n": 2})
            upload.req_writable.close()

            result = await upload.finalize()
            assert result["ok"] is True
            assert result["payload"]["result"] == 3
        finally:
            await cleanup_client(client)

    @pytest.mark.asyncio
    async def test_upload_empty(self, server_url: str):
        """Upload with no data returns zero."""
        client = await make_client(server_url)
        try:
            upload = client.upload("uploadable", "addMultiple", {})
            upload.req_writable.close()

            result = await upload.finalize()
            assert result["ok"] is True
            assert result["payload"]["result"] == 0
        finally:
            await cleanup_client(client)

    @pytest.mark.asyncio
    async def test_upload_with_init_message(self, server_url: str):
        """Upload handler receives the init message."""
        client = await make_client(server_url)
        try:
            upload = client.upload(
                "uploadable", "addMultipleWithPrefix", {"prefix": "test"}
            )
            upload.req_writable.write({"n": 1})
            upload.req_writable.write({"n": 2})
            upload.req_writable.close()

            result = await upload.finalize()
            assert result["ok"] is True
            assert result["payload"]["result"] == "test 3"
        finally:
            await cleanup_client(client)

    @pytest.mark.asyncio
    async def test_upload_server_cancel(self, server_url: str):
        """Upload receives server-initiated cancel when limit exceeded."""
        client = await make_client(server_url)
        try:
            upload = client.upload("uploadable", "cancellableAdd", {})
            upload.req_writable.write({"n": 9})
            upload.req_writable.write({"n": 1})
            # Don't close - server should cancel

            result = await upload.finalize()
            assert result["ok"] is False
            assert result["payload"]["code"] == "CANCEL"
        finally:
            await cleanup_client(client)


# =====================================================================
# Disconnect Tests
# =====================================================================


class TestDisconnect:
    @pytest.mark.asyncio
    async def test_rpc_on_closed_transport(self, server_url: str):
        """RPC on a closed transport returns UNEXPECTED_DISCONNECT."""
        client = await make_client(server_url)
        await client.transport.close()

        result = await client.rpc("test", "add", {"n": 1})
        assert result["ok"] is False
        assert result["payload"]["code"] == "UNEXPECTED_DISCONNECT"

    @pytest.mark.asyncio
    async def test_stream_on_closed_transport(self, server_url: str):
        """Stream on a closed transport returns UNEXPECTED_DISCONNECT."""
        client = await make_client(server_url)
        await client.transport.close()

        stream = client.stream("test", "echo", {})
        done, msg = await stream.res_readable.next()
        assert not done
        assert msg["ok"] is False
        assert msg["payload"]["code"] == "UNEXPECTED_DISCONNECT"

    @pytest.mark.asyncio
    async def test_upload_on_closed_transport(self, server_url: str):
        """Upload on a closed transport returns UNEXPECTED_DISCONNECT."""
        client = await make_client(server_url)
        await client.transport.close()

        upload = client.upload("uploadable", "addMultiple", {})
        assert not upload.req_writable.is_writable()
        result = await upload.finalize()
        assert result["ok"] is False
        assert result["payload"]["code"] == "UNEXPECTED_DISCONNECT"

    @pytest.mark.asyncio
    async def test_subscription_on_closed_transport(self, server_url: str):
        """Subscription on a closed transport returns UNEXPECTED_DISCONNECT."""
        client = await make_client(server_url)
        await client.transport.close()

        sub = client.subscribe("subscribable", "value", {})
        done, msg = await sub.res_readable.next()
        assert not done
        assert msg["ok"] is False
        assert msg["payload"]["code"] == "UNEXPECTED_DISCONNECT"


# =====================================================================
# Codec Tests
# =====================================================================


class TestCodec:
    @pytest.mark.asyncio
    async def test_json_codec_rpc(self, server_url: str):
        """JSON codec works for basic RPC."""
        transport = WebSocketClientTransport(
            ws_url=server_url,
            server_id="SERVER",
            codec=NaiveJsonCodec(),
        )
        client = RiverClient(transport, server_id="SERVER")
        try:
            result = await client.rpc("test", "add", {"n": 5})
            assert result["ok"] is True
        finally:
            await transport.close()

    @pytest.mark.asyncio
    async def test_binary_codec_roundtrip(self):
        """Binary (msgpack) codec encodes and decodes transport messages."""
        from river.codec import BinaryCodec, CodecMessageAdapter
        from river.types import TransportMessage

        adapter = CodecMessageAdapter(BinaryCodec())
        msg = TransportMessage(
            id="test123",
            from_="client",
            to="server",
            seq=1,
            ack=0,
            payload={"data": "hello"},
            stream_id="s1",
            control_flags=0,
        )
        ok, buf = adapter.to_buffer(msg)
        assert ok is True
        ok, decoded = adapter.from_buffer(buf)
        assert ok is True
        assert decoded.payload == {"data": "hello"}


# =====================================================================
# Stream Unit Tests
# =====================================================================


class TestReadable:
    @pytest.mark.asyncio
    async def test_readable_close(self):
        """Closing a readable makes it done."""
        from river.streams import Readable

        r: Readable = Readable()
        r._trigger_close()
        assert r.is_closed()

    @pytest.mark.asyncio
    async def test_readable_iterate(self):
        """Can iterate over pushed values."""
        from river.streams import Readable

        r: Readable = Readable()
        r._push_value({"ok": True, "payload": 1})
        r._push_value({"ok": True, "payload": 2})
        r._trigger_close()

        results = await r.collect()
        assert len(results) == 2
        assert results[0]["payload"] == 1
        assert results[1]["payload"] == 2

    @pytest.mark.asyncio
    async def test_readable_push_after_close_raises(self):
        """Pushing to a closed readable raises."""
        from river.streams import Readable

        r: Readable = Readable()
        r._trigger_close()
        with pytest.raises(RuntimeError):
            r._push_value({"ok": True, "payload": 1})

    @pytest.mark.asyncio
    async def test_readable_double_close_raises(self):
        """Closing a readable twice raises."""
        from river.streams import Readable

        r: Readable = Readable()
        r._trigger_close()
        with pytest.raises(RuntimeError):
            r._trigger_close()

    @pytest.mark.asyncio
    async def test_readable_break(self):
        """Breaking a readable stops iteration."""
        from river.streams import Readable

        r: Readable = Readable()
        r._push_value({"ok": True, "payload": 1})
        r.break_()

        results = await r.collect()
        assert len(results) == 1
        assert results[0]["ok"] is False
        assert results[0]["payload"]["code"] == "READABLE_BROKEN"

    @pytest.mark.asyncio
    async def test_readable_async_for(self):
        """Works with async for loop."""
        from river.streams import Readable

        r: Readable = Readable()
        r._push_value({"ok": True, "payload": "a"})
        r._push_value({"ok": True, "payload": "b"})
        r._trigger_close()

        values = []
        async for item in r:
            values.append(item)
        assert len(values) == 2


class TestWritable:
    def test_writable_write(self):
        """Write callback is invoked."""
        from river.streams import Writable

        received = []
        w: Writable = Writable(write_cb=received.append)
        w.write(1)
        w.write(2)
        assert received == [1, 2]

    def test_writable_close(self):
        """Close callback is invoked once."""
        from river.streams import Writable

        close_count = [0]
        w: Writable = Writable(
            write_cb=lambda x: None,
            close_cb=lambda: close_count.__setitem__(0, close_count[0] + 1),
        )
        assert w.is_writable()
        w.close()
        assert not w.is_writable()
        assert close_count[0] == 1

    def test_writable_idempotent_close(self):
        """Closing multiple times only invokes callback once."""
        from river.streams import Writable

        close_count = [0]
        w: Writable = Writable(
            write_cb=lambda x: None,
            close_cb=lambda: close_count.__setitem__(0, close_count[0] + 1),
        )
        w.close()
        w.close()
        w.close()
        assert close_count[0] == 1

    def test_writable_write_after_close_raises(self):
        """Writing after close raises."""
        from river.streams import Writable

        w: Writable = Writable(write_cb=lambda x: None)
        w.close()
        with pytest.raises(RuntimeError):
            w.write(42)

    def test_writable_close_with_value(self):
        """Close with a final value writes it before closing."""
        from river.streams import Writable

        received = []
        w: Writable = Writable(write_cb=received.append)
        w.close(42)
        assert received == [42]
        assert w.is_closed()


# =====================================================================
# Types Unit Tests
# =====================================================================


class TestTypes:
    def test_generate_id_length(self):
        """Generated IDs are 12 characters."""
        from river.types import generate_id

        for _ in range(100):
            assert len(generate_id()) == 12

    def test_generate_id_unique(self):
        """Generated IDs are unique."""
        from river.types import generate_id

        ids = {generate_id() for _ in range(1000)}
        assert len(ids) == 1000

    def test_control_flags(self):
        """Control flag bit operations work correctly."""
        from river.types import (
            ControlFlags,
            is_ack,
            is_stream_open,
            is_stream_cancel,
            is_stream_close,
        )

        assert is_ack(ControlFlags.AckBit)
        assert not is_ack(0)
        assert is_stream_open(ControlFlags.StreamOpenBit)
        assert is_stream_close(ControlFlags.StreamClosedBit)
        assert is_stream_cancel(ControlFlags.StreamCancelBit)

        # Combined flags
        combined = ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit
        assert is_stream_open(combined)
        assert is_stream_close(combined)
        assert not is_ack(combined)

    def test_transport_message_roundtrip(self):
        """TransportMessage serializes and deserializes correctly."""
        from river.types import TransportMessage

        msg = TransportMessage(
            id="test123",
            from_="client1",
            to="server1",
            seq=5,
            ack=3,
            payload={"data": "hello"},
            stream_id="stream1",
            control_flags=0,
            service_name="myService",
            procedure_name="myProc",
        )
        d = msg.to_dict()
        assert d["from"] == "client1"
        assert d["to"] == "server1"
        assert d["serviceName"] == "myService"

        msg2 = TransportMessage.from_dict(d)
        assert msg2.from_ == "client1"
        assert msg2.seq == 5
        assert msg2.service_name == "myService"


# =====================================================================
# Codec Unit Tests
# =====================================================================


class TestCodecUnit:
    def test_json_codec_encode_decode(self):
        """JSON codec round-trips correctly."""
        from river.codec import NaiveJsonCodec

        codec = NaiveJsonCodec()
        obj = {"key": "value", "num": 42, "nested": {"a": [1, 2, 3]}}
        buf = codec.to_buffer(obj)
        assert isinstance(buf, bytes)
        result = codec.from_buffer(buf)
        assert result == obj

    def test_json_codec_bytes_handling(self):
        """JSON codec handles bytes via base64."""
        from river.codec import NaiveJsonCodec

        codec = NaiveJsonCodec()
        obj = {"data": b"\x00\x01\x02\xff"}
        buf = codec.to_buffer(obj)
        result = codec.from_buffer(buf)
        assert result["data"] == b"\x00\x01\x02\xff"

    def test_binary_codec_encode_decode(self):
        """Binary (msgpack) codec round-trips correctly."""
        from river.codec import BinaryCodec

        codec = BinaryCodec()
        obj = {"key": "value", "num": 42, "nested": {"a": [1, 2, 3]}}
        buf = codec.to_buffer(obj)
        assert isinstance(buf, bytes)
        result = codec.from_buffer(buf)
        assert result == obj

    def test_codec_adapter_valid(self):
        """CodecMessageAdapter encodes and decodes transport messages."""
        from river.codec import CodecMessageAdapter, NaiveJsonCodec
        from river.types import TransportMessage

        adapter = CodecMessageAdapter(NaiveJsonCodec())
        msg = TransportMessage(
            id="abc",
            from_="c1",
            to="s1",
            seq=0,
            ack=0,
            payload={"type": "ACK"},
            stream_id="heartbeat",
            control_flags=1,
        )
        ok, buf = adapter.to_buffer(msg)
        assert ok is True

        ok, result = adapter.from_buffer(buf)
        assert ok is True
        assert result.id == "abc"
        assert result.from_ == "c1"

    def test_codec_adapter_invalid_buffer(self):
        """CodecMessageAdapter returns error on invalid bytes."""
        from river.codec import CodecMessageAdapter, NaiveJsonCodec

        adapter = CodecMessageAdapter(NaiveJsonCodec())
        ok, result = adapter.from_buffer(b"not valid json")
        assert ok is False
        assert isinstance(result, str)
