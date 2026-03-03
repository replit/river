"""Tests for River codegen pipeline.

Tests the full pipeline: schema extraction → codegen → import → live usage.
"""

from __future__ import annotations

import json
import os
import sys

import pytest

TESTS_DIR = os.path.dirname(__file__)
SCHEMA_JSON = os.path.join(TESTS_DIR, "test_schema.json")
GENERATED_DIR = os.path.join(TESTS_DIR, "generated")


# ---------------------------------------------------------------------------
# Schema conversion tests
# ---------------------------------------------------------------------------


class TestSchemaConversion:
    """Test JSON Schema → IR conversion."""

    @pytest.fixture(autouse=True)
    def _setup(self, generated_client_dir: str) -> None:
        """Ensure codegen has run."""

    def _load_schema(self) -> dict:
        with open(SCHEMA_JSON) as f:
            return json.load(f)

    def test_schema_has_services(self) -> None:
        schema = self._load_schema()
        assert "services" in schema
        svc_names = set(schema["services"].keys())
        assert svc_names == {
            "test",
            "ordering",
            "fallible",
            "subscribable",
            "uploadable",
            "cancel",
        }

    def test_converter_produces_ir(self) -> None:
        from river.codegen.schema import SchemaConverter

        schema = self._load_schema()
        converter = SchemaConverter()
        ir = converter.convert(schema)

        svc_names = {s.name for s in ir.services}
        assert svc_names == {
            "test",
            "ordering",
            "fallible",
            "subscribable",
            "uploadable",
            "cancel",
        }

    def test_test_service_procedures(self) -> None:
        from river.codegen.schema import SchemaConverter

        schema = self._load_schema()
        converter = SchemaConverter()
        ir = converter.convert(schema)

        test_svc = next(s for s in ir.services if s.name == "test")
        proc_names = {p.name for p in test_svc.procedures}
        assert "add" in proc_names
        assert "echo" in proc_names
        assert "echoWithPrefix" in proc_names

    def test_procedure_types(self) -> None:
        from river.codegen.schema import SchemaConverter

        schema = self._load_schema()
        converter = SchemaConverter()
        ir = converter.convert(schema)

        test_svc = next(s for s in ir.services if s.name == "test")
        procs = {p.name: p for p in test_svc.procedures}

        assert procs["add"].proc_type == "rpc"
        assert procs["echo"].proc_type == "stream"
        assert procs["echoWithPrefix"].proc_type == "stream"

    def test_snake_case_method_names(self) -> None:
        from river.codegen.schema import SchemaConverter

        schema = self._load_schema()
        converter = SchemaConverter()
        ir = converter.convert(schema)

        test_svc = next(s for s in ir.services if s.name == "test")
        procs = {p.name: p for p in test_svc.procedures}

        assert procs["echoWithPrefix"].py_name == "echo_with_prefix"
        assert procs["add"].py_name == "add"

    def test_typedicts_generated(self) -> None:
        from river.codegen.schema import SchemaConverter

        schema = self._load_schema()
        converter = SchemaConverter()
        ir = converter.convert(schema)

        td_names = {td.name for td in ir.typedicts}
        assert "TestAddInit" in td_names
        assert "TestEchoInit" in td_names
        assert "TestEchoInput" in td_names
        assert "TestEchoWithPrefixInit" in td_names

    def test_fallible_service_errors(self) -> None:
        from river.codegen.schema import SchemaConverter

        schema = self._load_schema()
        converter = SchemaConverter()
        ir = converter.convert(schema)

        fallible_svc = next(s for s in ir.services if s.name == "fallible")
        divide_proc = next(p for p in fallible_svc.procedures if p.name == "divide")

        # Should have service-specific errors
        assert divide_proc.error_type is not None
        assert "DivByZero" in divide_proc.error_type.annotation
        assert "Infinity" in divide_proc.error_type.annotation

    def test_upload_procedures(self) -> None:
        from river.codegen.schema import SchemaConverter

        schema = self._load_schema()
        converter = SchemaConverter()
        ir = converter.convert(schema)

        upload_svc = next(s for s in ir.services if s.name == "uploadable")
        procs = {p.name: p for p in upload_svc.procedures}

        assert procs["addMultiple"].proc_type == "upload"
        assert procs["addMultiple"].input_type is not None

    def test_subscription_procedures(self) -> None:
        from river.codegen.schema import SchemaConverter

        schema = self._load_schema()
        converter = SchemaConverter()
        ir = converter.convert(schema)

        sub_svc = next(s for s in ir.services if s.name == "subscribable")
        procs = {p.name: p for p in sub_svc.procedures}

        assert procs["value"].proc_type == "subscription"
        assert procs["value"].input_type is None


# ---------------------------------------------------------------------------
# Generated code import tests
# ---------------------------------------------------------------------------


class TestGeneratedImports:
    """Test that generated code can be imported."""

    @pytest.fixture(autouse=True)
    def _setup(self, generated_client_dir: str) -> None:
        """Ensure codegen has run and generated dir is on sys.path."""
        if TESTS_DIR not in sys.path:
            sys.path.insert(0, TESTS_DIR)

    def test_import_init(self) -> None:
        import generated

        assert hasattr(generated, "TestClient")
        assert hasattr(generated, "FallibleClient")
        assert hasattr(generated, "UploadableClient")
        assert hasattr(generated, "SubscribableClient")
        assert hasattr(generated, "OrderingClient")
        assert hasattr(generated, "CancelClient")

    def test_import_types(self) -> None:
        from generated._types import (
            TestAddInit,
            TestEchoInit,
            TestEchoInput,
            TestEchoWithPrefixInit,
        )

        # TypedDicts should be classes
        assert isinstance(TestAddInit, type)
        assert isinstance(TestEchoInit, type)
        assert isinstance(TestEchoInput, type)
        assert isinstance(TestEchoWithPrefixInit, type)

    def test_import_errors(self) -> None:
        from generated._errors import (
            Cancel,
            InvalidRequest,
            UncaughtError,
            UnexpectedDisconnect,
        )

        assert isinstance(UncaughtError, type)
        assert isinstance(UnexpectedDisconnect, type)
        assert isinstance(InvalidRequest, type)
        assert isinstance(Cancel, type)

    def test_client_class_has_methods(self) -> None:
        from generated import TestClient

        assert hasattr(TestClient, "add")
        assert hasattr(TestClient, "echo")
        assert hasattr(TestClient, "echo_with_prefix")

    def test_fallible_client_has_methods(self) -> None:
        from generated import FallibleClient

        assert hasattr(FallibleClient, "divide")
        assert hasattr(FallibleClient, "echo")

    def test_uploadable_client_has_methods(self) -> None:
        from generated import UploadableClient

        assert hasattr(UploadableClient, "add_multiple")
        assert hasattr(UploadableClient, "add_multiple_with_prefix")
        assert hasattr(UploadableClient, "cancellable_add")

    def test_subscribable_client_has_methods(self) -> None:
        from generated import SubscribableClient

        assert hasattr(SubscribableClient, "add")
        assert hasattr(SubscribableClient, "value")


# ---------------------------------------------------------------------------
# Live test server integration tests
# ---------------------------------------------------------------------------


class TestGeneratedClientsLive:
    """Test generated proxy clients against the live test server."""

    @pytest.fixture(autouse=True)
    def _setup(self, generated_client_dir: str) -> None:
        if TESTS_DIR not in sys.path:
            sys.path.insert(0, TESTS_DIR)

    async def _make_client(self, server_url: str):
        from river import (
            NaiveJsonCodec,
            RiverClient,
            WebSocketClientTransport,
        )

        transport = WebSocketClientTransport(
            server_url,
            client_id="test-codegen-client",
            server_id="SERVER",
            codec=NaiveJsonCodec(),
        )
        client = RiverClient(transport, server_id="SERVER")
        return client, transport

    async def test_rpc_via_generated_client(self, server_url: str) -> None:
        from generated import TestClient

        client, transport = await self._make_client(server_url)
        try:
            test = TestClient(client)
            result = await test.add({"n": 0})
            assert result["ok"] is True
            assert isinstance(result["payload"]["result"], (int, float))
        finally:
            await transport.close()

    async def test_stream_via_generated_client(self, server_url: str) -> None:
        from generated import TestClient

        client, transport = await self._make_client(server_url)
        try:
            test = TestClient(client)
            stream = test.echo({})

            stream.req_writable.write({"msg": "hello", "ignore": False})
            stream.req_writable.write({"msg": "world", "ignore": False})
            stream.req_writable.close()

            messages = []
            async for msg in stream.res_readable:
                if msg.get("ok"):
                    messages.append(msg["payload"]["response"])

            assert "hello" in messages
            assert "world" in messages
        finally:
            await transport.close()

    async def test_stream_with_prefix_via_generated_client(
        self, server_url: str
    ) -> None:
        from generated import TestClient

        client, transport = await self._make_client(server_url)
        try:
            test = TestClient(client)
            stream = test.echo_with_prefix({"prefix": ">>>"})

            stream.req_writable.write({"msg": "test", "ignore": False})
            stream.req_writable.close()

            messages = []
            async for msg in stream.res_readable:
                if msg.get("ok"):
                    messages.append(msg["payload"]["response"])

            assert len(messages) == 1
            assert messages[0] == ">>> test"
        finally:
            await transport.close()

    async def test_upload_via_generated_client(self, server_url: str) -> None:
        from generated import UploadableClient

        client, transport = await self._make_client(server_url)
        try:
            upload_client = UploadableClient(client)
            upload = upload_client.add_multiple({})

            upload.req_writable.write({"n": 1})
            upload.req_writable.write({"n": 2})
            upload.req_writable.write({"n": 3})
            upload.req_writable.close()

            result = await upload.finalize()
            assert result["ok"] is True
            assert result["payload"]["result"] == 6
        finally:
            await transport.close()

    async def test_subscription_via_generated_client(self, server_url: str) -> None:
        from generated import SubscribableClient

        client, transport = await self._make_client(server_url)
        try:
            sub_client = SubscribableClient(client)
            sub = sub_client.value({})

            # Get the initial value
            done, msg = await sub.res_readable.next()
            assert not done
            assert msg is not None
            assert msg["ok"] is True
            assert "count" in msg["payload"]

            sub.res_readable.break_()
        finally:
            await transport.close()

    async def test_fallible_rpc_success(self, server_url: str) -> None:
        from generated import FallibleClient

        client, transport = await self._make_client(server_url)
        try:
            fallible = FallibleClient(client)
            result = await fallible.divide({"a": 10, "b": 2})
            assert result["ok"] is True
            assert result["payload"]["result"] == 5.0
        finally:
            await transport.close()

    async def test_fallible_rpc_error(self, server_url: str) -> None:
        from generated import FallibleClient

        client, transport = await self._make_client(server_url)
        try:
            fallible = FallibleClient(client)
            result = await fallible.divide({"a": 10, "b": 0})
            assert result["ok"] is False
            assert result["payload"]["code"] == "DIV_BY_ZERO"
        finally:
            await transport.close()


class TestCodegenFieldNames:
    """Codegen field name validation tests."""

    def test_keyword_field_raises(self):
        """Python keywords are rejected at codegen time."""
        from river.codegen.schema import _safe_field_name

        with pytest.raises(ValueError, match="Python keyword"):
            _safe_field_name("from")
        with pytest.raises(ValueError, match="Python keyword"):
            _safe_field_name("class")
        with pytest.raises(ValueError, match="Python keyword"):
            _safe_field_name("import")

    def test_normal_field_unchanged(self):
        from river.codegen.schema import _safe_field_name

        assert _safe_field_name("name") == "name"
        assert _safe_field_name("streamId") == "streamId"

    def test_dash_field_raises(self):
        """Fields with dashes are rejected at codegen time."""
        from river.codegen.schema import _safe_field_name

        with pytest.raises(ValueError, match="not a valid Python identifier"):
            _safe_field_name("request-id")

    def test_schema_with_invalid_field_raises(self):
        """Codegen rejects schemas with non-identifier property names."""
        from river.codegen.schema import SchemaConverter

        converter = SchemaConverter()
        schema = {
            "type": "object",
            "properties": {
                "request-id": {"type": "string"},
                "normal": {"type": "string"},
            },
            "required": ["request-id", "normal"],
        }
        with pytest.raises(ValueError, match="not a valid Python identifier"):
            converter._schema_to_typeref(schema, "TestObj")

    def test_schema_with_keyword_field_raises(self):
        """Codegen rejects schemas with keyword property names."""
        from river.codegen.schema import SchemaConverter

        converter = SchemaConverter()
        schema = {
            "type": "object",
            "properties": {
                "from": {"type": "string"},
            },
            "required": ["from"],
        }
        with pytest.raises(ValueError, match="Python keyword"):
            converter._schema_to_typeref(schema, "TestObj")

    def test_valid_schema_passes(self):
        """Schemas with normal camelCase properties work fine."""
        from river.codegen.schema import SchemaConverter

        converter = SchemaConverter()
        schema = {
            "type": "object",
            "properties": {
                "userId": {"type": "string"},
                "count": {"type": "number"},
            },
            "required": ["userId", "count"],
        }
        ref = converter._schema_to_typeref(schema, "TestObj")
        assert ref.annotation == "TestObj"
        td = converter._typedicts[-1]
        assert [f.name for f in td.fields] == ["userId", "count"]
