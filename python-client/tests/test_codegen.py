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
            BinaryCodec,
            RiverClient,
            WebSocketClientTransport,
        )

        transport = WebSocketClientTransport(
            server_url,
            client_id="test-codegen-client",
            server_id="SERVER",
            codec=BinaryCodec(),
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

    def test_underscore_prefixed_field_accepted(self):
        """Underscore-prefixed fields like _id are valid Python identifiers.

        Regression: _sanitize_identifier stripped leading underscores,
        causing _safe_field_name to reject valid fields like '_id'.
        """
        from river.codegen.schema import _safe_field_name

        assert _safe_field_name("_id") == "_id"
        assert _safe_field_name("_private") == "_private"

    def test_dunder_field_rejected(self):
        """Double-underscore-prefixed fields are name-mangled in class bodies.

        Regression: after allowing leading underscores, __dunder fields
        were accepted but would be name-mangled in the generated TypedDict
        class body, making the key not match the wire representation.
        """
        from river.codegen.schema import _safe_field_name

        with pytest.raises(ValueError, match="name-mangled"):
            _safe_field_name("__dunder")
        with pytest.raises(ValueError, match="name-mangled"):
            _safe_field_name("__private")
        # Dunder methods (ending with __) are NOT mangled
        assert _safe_field_name("__init__") == "__init__"

    def test_schema_with_underscore_prefixed_field(self):
        """Schemas with underscore-prefixed properties generate correctly."""
        from river.codegen.schema import SchemaConverter

        converter = SchemaConverter()
        schema = {
            "type": "object",
            "properties": {
                "_id": {"type": "string"},
                "name": {"type": "string"},
            },
            "required": ["_id", "name"],
        }
        ref = converter._schema_to_typeref(schema, "Doc")
        assert ref.annotation == "Doc"
        td = converter._typedicts[-1]
        field_names = [f.name for f in td.fields]
        assert "_id" in field_names
        assert "name" in field_names

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


class TestNameCollisions:
    """Codegen detects and rejects name collisions."""

    def test_procedure_name_collision_raises(self):
        """Two procedures that map to the same snake_case name are rejected."""
        from river.codegen.schema import SchemaConverter

        raw = {
            "services": {
                "svc": {
                    "procedures": {
                        "fooBar": {
                            "type": "rpc",
                            "init": {"type": "object", "properties": {}},
                            "output": {"type": "object", "properties": {}},
                        },
                        "foo_bar": {
                            "type": "rpc",
                            "init": {"type": "object", "properties": {}},
                            "output": {"type": "object", "properties": {}},
                        },
                    }
                }
            }
        }
        converter = SchemaConverter()
        with pytest.raises(ValueError, match="foo_bar"):
            converter.convert(raw)

    def test_service_module_collision_raises(self):
        """Two services that map to the same module name are rejected."""
        from river.codegen.schema import SchemaConverter

        raw = {
            "services": {
                "foo-bar": {
                    "procedures": {},
                },
                "foo_bar": {
                    "procedures": {},
                },
            }
        }
        converter = SchemaConverter()
        with pytest.raises(ValueError, match="foo_bar"):
            converter.convert(raw)

    def test_no_collision_passes(self):
        """Distinct names that don't collide work fine."""
        from river.codegen.schema import SchemaConverter

        raw = {
            "services": {
                "alpha": {
                    "procedures": {
                        "doX": {
                            "type": "rpc",
                            "init": {"type": "object", "properties": {}},
                            "output": {"type": "object", "properties": {}},
                        },
                        "doY": {
                            "type": "rpc",
                            "init": {"type": "object", "properties": {}},
                            "output": {"type": "object", "properties": {}},
                        },
                    }
                },
                "beta": {
                    "procedures": {},
                },
            }
        }
        converter = SchemaConverter()
        ir = converter.convert(raw)
        assert len(ir.services) == 2

    def test_service_class_name_collision_raises(self):
        """Two services that map to the same class name are rejected."""
        from river.codegen.schema import SchemaConverter

        raw = {
            "services": {
                "foo_bar": {"procedures": {}},
                "FooBar": {"procedures": {}},
            }
        }
        converter = SchemaConverter()
        with pytest.raises(ValueError, match="FooBarClient"):
            converter.convert(raw)

    def test_description_with_triple_quotes(self):
        """Descriptions containing triple quotes are escaped in output."""
        from river.codegen.emitter import _escape_docstring

        assert '"""' not in _escape_docstring('bad """ doc')
        assert _escape_docstring('say """hello"""') == r"say \"\"\"hello\"\"\""


# ---------------------------------------------------------------------------
# Complex type tests
# ---------------------------------------------------------------------------


class TestComplexTypes:
    """Test codegen with complex JSON Schema types."""

    def _convert(self, schema: dict, name: str = "Test"):
        from river.codegen.schema import SchemaConverter

        converter = SchemaConverter()
        ref = converter._schema_to_typeref(schema, name)
        return ref, converter._typedicts

    # -- Deeply nested objects --

    def test_deeply_nested_objects(self):
        """Objects nested 4 levels deep get path-derived names."""
        schema = {
            "type": "object",
            "properties": {
                "level1": {
                    "type": "object",
                    "properties": {
                        "level2": {
                            "type": "object",
                            "properties": {
                                "level3": {
                                    "type": "object",
                                    "properties": {
                                        "value": {"type": "string"},
                                    },
                                    "required": ["value"],
                                }
                            },
                            "required": ["level3"],
                        }
                    },
                    "required": ["level2"],
                }
            },
            "required": ["level1"],
        }
        ref, tds = self._convert(schema, "Root")
        assert ref.annotation == "Root"

        td_names = [td.name for td in tds]
        assert "Root" in td_names
        assert "RootLevel1" in td_names
        assert "RootLevel1Level2" in td_names
        assert "RootLevel1Level2Level3" in td_names

        # Innermost TypedDict has the value field
        innermost = next(td for td in tds if td.name == "RootLevel1Level2Level3")
        assert len(innermost.fields) == 1
        assert innermost.fields[0].name == "value"
        assert innermost.fields[0].type_ref.annotation == "str"

    def test_nested_object_in_array(self):
        """Array of objects creates a TypedDict for the item type."""
        schema = {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "number"},
                    "name": {"type": "string"},
                },
                "required": ["id", "name"],
            },
        }
        ref, tds = self._convert(schema, "ItemList")
        assert ref.annotation == "list[ItemListItem]"
        assert any(td.name == "ItemListItem" for td in tds)

    def test_nested_array_of_arrays(self):
        """Nested arrays: list[list[str]]."""
        schema = {
            "type": "array",
            "items": {
                "type": "array",
                "items": {"type": "string"},
            },
        }
        ref, _ = self._convert(schema, "Matrix")
        assert ref.annotation == "list[list[str]]"

    # -- Union types (anyOf) --

    def test_discriminated_union_with_code_field(self):
        """anyOf with const code fields → named TypedDicts."""
        schema = {
            "anyOf": [
                {
                    "type": "object",
                    "properties": {
                        "code": {"const": "SUCCESS"},
                        "data": {"type": "string"},
                    },
                    "required": ["code", "data"],
                },
                {
                    "type": "object",
                    "properties": {
                        "code": {"const": "FAILURE"},
                        "reason": {"type": "string"},
                    },
                    "required": ["code", "reason"],
                },
            ]
        }
        ref, tds = self._convert(schema, "Result")
        assert "ResultSuccess" in ref.annotation
        assert "ResultFailure" in ref.annotation
        assert "|" in ref.annotation

        td_names = {td.name for td in tds}
        assert "ResultSuccess" in td_names
        assert "ResultFailure" in td_names

    def test_non_discriminated_union_objects(self):
        """anyOf with objects but no const code → indexed variant names."""
        schema = {
            "anyOf": [
                {
                    "type": "object",
                    "properties": {"x": {"type": "number"}},
                    "required": ["x"],
                },
                {
                    "type": "object",
                    "properties": {"y": {"type": "string"}},
                    "required": ["y"],
                },
            ]
        }
        ref, tds = self._convert(schema, "Point")
        # Without code or description, should get Variant0/Variant1
        assert "PointVariant0" in ref.annotation
        assert "PointVariant1" in ref.annotation

    def test_union_mixed_types_primitives_and_objects(self):
        """anyOf mixing primitives and objects."""
        schema = {
            "anyOf": [
                {"type": "string"},
                {"type": "number"},
                {
                    "type": "object",
                    "properties": {"value": {"type": "boolean"}},
                    "required": ["value"],
                },
            ]
        }
        ref, tds = self._convert(schema, "Mixed")
        # Should include str, float, and a TypedDict
        assert "str" in ref.annotation
        assert "float" in ref.annotation
        assert "MixedVariant2" in ref.annotation
        assert any(td.name == "MixedVariant2" for td in tds)

    def test_union_with_null(self):
        """anyOf with null → includes None in union."""
        schema = {
            "anyOf": [
                {"type": "string"},
                {"type": "null"},
            ]
        }
        ref, _ = self._convert(schema, "Nullable")
        assert "str" in ref.annotation
        assert "None" in ref.annotation

    def test_union_primitives_only(self):
        """anyOf with only primitives → no TypedDicts created."""
        schema = {
            "anyOf": [
                {"type": "string"},
                {"type": "number"},
                {"type": "boolean"},
            ]
        }
        ref, tds = self._convert(schema, "Prim")
        assert ref.annotation == "str | float | bool"
        # No TypedDicts should be created for primitives
        assert len(tds) == 0

    def test_single_variant_anyof_unwrapped(self):
        """anyOf with a single variant is unwrapped."""
        schema = {
            "anyOf": [
                {"type": "string"},
            ]
        }
        ref, _ = self._convert(schema, "Single")
        assert ref.annotation == "str"

    def test_union_with_description_variants(self):
        """anyOf variants with descriptions use them for names."""
        schema = {
            "anyOf": [
                {
                    "description": "Circle",
                    "type": "object",
                    "properties": {"radius": {"type": "number"}},
                    "required": ["radius"],
                },
                {
                    "description": "Rectangle",
                    "type": "object",
                    "properties": {
                        "width": {"type": "number"},
                        "height": {"type": "number"},
                    },
                    "required": ["width", "height"],
                },
            ]
        }
        ref, tds = self._convert(schema, "Shape")
        assert "ShapeCircle" in ref.annotation
        assert "ShapeRectangle" in ref.annotation

    # -- Recursive / self-referencing schemas --

    def test_recursive_ref_with_id(self):
        """$id/$ref pair → forward reference by name."""
        schema = {
            "$id": "T0",
            "type": "object",
            "properties": {
                "n": {"type": "number"},
                "next": {"$ref": "T0"},
            },
            "required": ["n"],
        }
        ref, tds = self._convert(schema, "TreeNode")
        assert ref.annotation == "TreeNode"
        td = next(td for td in tds if td.name == "TreeNode")
        next_field = next(f for f in td.fields if f.name == "next")
        # Should be a forward reference to itself, not Any
        assert next_field.type_ref.annotation == "TreeNode"

    def test_recursive_ref_in_array(self):
        """Recursive type used as array items."""
        schema = {
            "$id": "Node",
            "type": "object",
            "properties": {
                "value": {"type": "string"},
                "children": {
                    "type": "array",
                    "items": {"$ref": "Node"},
                },
            },
            "required": ["value"],
        }
        ref, tds = self._convert(schema, "TreeNode")
        assert ref.annotation == "TreeNode"
        td = next(td for td in tds if td.name == "TreeNode")
        children_field = next(f for f in td.fields if f.name == "children")
        assert children_field.type_ref.annotation == "list[TreeNode]"

    def test_unknown_ref_is_never(self):
        """$ref to an unknown $id → Never (broken schema)."""
        schema = {"$ref": "NonExistent"}
        ref, _ = self._convert(schema, "X")
        assert ref.annotation == "Never"

    def test_multiple_recursive_types(self):
        """Two independent recursive types don't collide."""
        from river.codegen.schema import SchemaConverter

        converter = SchemaConverter()

        schema_a = {
            "$id": "A",
            "type": "object",
            "properties": {
                "val": {"type": "number"},
                "link": {"$ref": "A"},
            },
            "required": ["val"],
        }
        schema_b = {
            "$id": "B",
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "parent": {"$ref": "B"},
            },
            "required": ["name"],
        }

        ref_a = converter._schema_to_typeref(schema_a, "LinkedList")
        ref_b = converter._schema_to_typeref(schema_b, "Category")

        assert ref_a.annotation == "LinkedList"
        assert ref_b.annotation == "Category"

        tds = converter._typedicts
        ll = next(td for td in tds if td.name == "LinkedList")
        cat = next(td for td in tds if td.name == "Category")

        link_field = next(f for f in ll.fields if f.name == "link")
        assert link_field.type_ref.annotation == "LinkedList"

        parent_field = next(f for f in cat.fields if f.name == "parent")
        assert parent_field.type_ref.annotation == "Category"

    # -- Const values --

    def test_const_string(self):
        ref, _ = self._convert({"const": "hello"}, "X")
        assert ref.annotation == 'Literal["hello"]'

    def test_const_number(self):
        ref, _ = self._convert({"const": 42}, "X")
        assert ref.annotation == "Literal[42]"

    def test_const_boolean(self):
        ref, _ = self._convert({"const": True}, "X")
        assert ref.annotation == "Literal[True]"

    def test_const_string_with_special_chars(self):
        """Const strings with quotes/backslashes are properly escaped."""
        ref, _ = self._convert({"const": 'say "hello"'}, "X")
        assert "Literal[" in ref.annotation
        # Should be valid Python — no unescaped quotes
        assert ref.annotation.count('"') % 2 == 0 or '\\"' in ref.annotation

    # -- Edge cases --

    def test_empty_object(self):
        """Object with no properties → TypedDict with pass."""
        schema = {"type": "object", "properties": {}}
        ref, tds = self._convert(schema, "Empty")
        assert ref.annotation == "Empty"
        td = next(td for td in tds if td.name == "Empty")
        assert len(td.fields) == 0

    def test_object_all_optional_fields(self):
        """Object with no required fields → all NotRequired."""
        schema = {
            "type": "object",
            "properties": {
                "a": {"type": "string"},
                "b": {"type": "number"},
            },
            # no "required" key
        }
        ref, tds = self._convert(schema, "Opts")
        td = next(td for td in tds if td.name == "Opts")
        assert all(not f.required for f in td.fields)

    def test_object_mixed_required_optional(self):
        """Object with some required, some optional fields."""
        schema = {
            "type": "object",
            "properties": {
                "id": {"type": "number"},
                "name": {"type": "string"},
                "email": {"type": "string"},
            },
            "required": ["id"],
        }
        ref, tds = self._convert(schema, "User")
        td = next(td for td in tds if td.name == "User")
        field_map = {f.name: f for f in td.fields}
        assert field_map["id"].required is True
        assert field_map["name"].required is False
        assert field_map["email"].required is False

    def test_unknown_type_falls_back_to_any(self):
        """Unrecognized type string → Any."""
        ref, _ = self._convert({"type": "foobar"}, "X")
        assert ref.annotation == "Any"

    def test_no_type_no_anyof_no_const_falls_back_to_any(self):
        """Schema with no recognizable keys → Any."""
        ref, _ = self._convert({"description": "mystery"}, "X")
        assert ref.annotation == "Any"

    def test_non_dict_schema_falls_back_to_any(self):
        """Non-dict passed as schema → Any."""
        from river.codegen.schema import SchemaConverter

        converter = SchemaConverter()
        ref = converter._schema_to_typeref("not a dict", "X")  # type: ignore[arg-type]
        assert ref.annotation == "Any"

    def test_array_with_no_items(self):
        """Array with no items key → list[Any]."""
        ref, _ = self._convert({"type": "array"}, "X")
        assert ref.annotation == "list[Any]"

    def test_all_primitive_types(self):
        """All primitive JSON Schema types map correctly."""
        cases = {
            "string": "str",
            "number": "float",
            "integer": "int",
            "boolean": "bool",
            "null": "None",
            "Uint8Array": "bytes",
        }
        for json_type, py_type in cases.items():
            ref, _ = self._convert({"type": json_type}, "X")
            assert ref.annotation == py_type, f"Failed for {json_type}"

    # -- allOf (intersection) --

    def test_allof_merges_object_properties(self):
        """allOf with objects → merged TypedDict."""
        schema = {
            "allOf": [
                {
                    "type": "object",
                    "properties": {
                        "a": {"type": "string"},
                        "b": {"type": "number"},
                    },
                    "required": ["a", "b"],
                },
                {
                    "type": "object",
                    "properties": {
                        "c": {"type": "boolean"},
                    },
                    "required": ["c"],
                },
            ]
        }
        ref, tds = self._convert(schema, "Merged")
        assert ref.annotation == "Merged"
        td = next(td for td in tds if td.name == "Merged")
        field_map = {f.name: f for f in td.fields}
        assert field_map["a"].type_ref.annotation == "str"
        assert field_map["b"].type_ref.annotation == "float"
        assert field_map["c"].type_ref.annotation == "bool"
        assert all(f.required for f in td.fields)

    def test_allof_with_type_object_wrapper(self):
        """TypeBox emits {type: 'object', allOf: [...]} — both forms work."""
        schema = {
            "type": "object",
            "allOf": [
                {
                    "type": "object",
                    "properties": {"x": {"type": "number"}},
                    "required": ["x"],
                },
                {
                    "type": "object",
                    "properties": {"y": {"type": "number"}},
                    "required": ["y"],
                },
            ],
        }
        ref, tds = self._convert(schema, "Point")
        assert ref.annotation == "Point"
        td = next(td for td in tds if td.name == "Point")
        assert {f.name for f in td.fields} == {"x", "y"}

    def test_allof_overlapping_fields(self):
        """Overlapping properties in allOf → last definition wins."""
        schema = {
            "allOf": [
                {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "name": {"type": "string"},
                    },
                    "required": ["id", "name"],
                },
                {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "age": {"type": "number"},
                    },
                    "required": ["name"],
                },
            ]
        }
        ref, tds = self._convert(schema, "Person")
        assert ref.annotation == "Person"
        td = next(td for td in tds if td.name == "Person")
        field_map = {f.name: f for f in td.fields}
        # "id" required from first, "name" required from both, "age" optional
        assert field_map["id"].required is True
        assert field_map["name"].required is True
        assert field_map["age"].required is False

    def test_allof_with_nested_objects(self):
        """allOf variants can contain nested objects."""
        schema = {
            "allOf": [
                {
                    "type": "object",
                    "properties": {
                        "meta": {
                            "type": "object",
                            "properties": {"version": {"type": "number"}},
                            "required": ["version"],
                        }
                    },
                    "required": ["meta"],
                },
                {
                    "type": "object",
                    "properties": {
                        "data": {"type": "string"},
                    },
                    "required": ["data"],
                },
            ]
        }
        ref, tds = self._convert(schema, "Envelope")
        assert ref.annotation == "Envelope"
        td_names = {td.name for td in tds}
        assert "Envelope" in td_names
        assert "EnvelopeMeta" in td_names

    def test_allof_mixed_types_merges_objects(self):
        """allOf with object + primitive → object properties still merged."""
        schema = {
            "allOf": [
                {
                    "type": "object",
                    "properties": {"x": {"type": "number"}},
                    "required": ["x"],
                },
                {"type": "string"},
            ]
        }
        ref, tds = self._convert(schema, "Mixed")
        # Object properties are merged; primitive constraint is ignored
        assert ref.annotation == "Mixed"
        td = next(td for td in tds if td.name == "Mixed")
        assert len(td.fields) == 1
        assert td.fields[0].name == "x"

    def test_allof_only_primitives_is_never(self):
        """allOf with only primitives → Never (contradictory intersection)."""
        schema = {
            "allOf": [
                {"type": "string"},
                {"type": "number"},
            ]
        }
        ref, _ = self._convert(schema, "Weird")
        assert ref.annotation == "Never"

    def test_allof_empty_is_never(self):
        """allOf with no variants → Never."""
        schema = {"allOf": []}
        ref, _ = self._convert(schema, "Empty")
        assert ref.annotation == "Never"

    # -- Full service schema with complex types --

    def test_service_with_complex_types(self):
        """Full service schema with unions, nested objects, arrays."""
        from river.codegen.schema import SchemaConverter

        raw = {
            "services": {
                "complex": {
                    "procedures": {
                        "transform": {
                            "type": "rpc",
                            "init": {
                                "type": "object",
                                "properties": {
                                    "input": {
                                        "anyOf": [
                                            {"type": "string"},
                                            {"type": "number"},
                                            {
                                                "type": "object",
                                                "properties": {
                                                    "nested": {
                                                        "type": "object",
                                                        "properties": {
                                                            "deep": {"type": "boolean"}
                                                        },
                                                        "required": ["deep"],
                                                    }
                                                },
                                                "required": ["nested"],
                                            },
                                        ]
                                    },
                                    "tags": {
                                        "type": "array",
                                        "items": {
                                            "type": "object",
                                            "properties": {
                                                "key": {"type": "string"},
                                                "value": {"type": "string"},
                                            },
                                            "required": ["key", "value"],
                                        },
                                    },
                                },
                                "required": ["input"],
                            },
                            "output": {
                                "type": "object",
                                "properties": {
                                    "result": {"type": "string"},
                                },
                                "required": ["result"],
                            },
                            "errors": {
                                "anyOf": [
                                    {
                                        "properties": {
                                            "code": {"const": "UNCAUGHT_ERROR"},
                                            "message": {"type": "string"},
                                        },
                                        "required": ["code", "message"],
                                        "type": "object",
                                    },
                                    {
                                        "properties": {
                                            "code": {"const": "UNEXPECTED_DISCONNECT"},
                                            "message": {"type": "string"},
                                        },
                                        "required": ["code", "message"],
                                        "type": "object",
                                    },
                                    {
                                        "properties": {
                                            "code": {"const": "INVALID_REQUEST"},
                                            "message": {"type": "string"},
                                        },
                                        "required": ["code", "message"],
                                        "type": "object",
                                    },
                                    {
                                        "properties": {
                                            "code": {"const": "CANCEL"},
                                            "message": {"type": "string"},
                                        },
                                        "required": ["code", "message"],
                                        "type": "object",
                                    },
                                    {
                                        "properties": {
                                            "code": {"const": "TRANSFORM_FAILED"},
                                            "message": {"type": "string"},
                                            "details": {
                                                "type": "object",
                                                "properties": {
                                                    "field": {"type": "string"},
                                                    "reason": {"type": "string"},
                                                },
                                                "required": ["field", "reason"],
                                            },
                                        },
                                        "required": ["code", "message"],
                                        "type": "object",
                                    },
                                ]
                            },
                        }
                    }
                }
            }
        }

        converter = SchemaConverter()
        ir = converter.convert(raw)

        assert len(ir.services) == 1
        svc = ir.services[0]
        assert svc.name == "complex"
        assert len(svc.procedures) == 1

        proc = svc.procedures[0]
        assert proc.name == "transform"
        assert proc.py_name == "transform"

        # Init should have created TypedDicts for nested objects
        td_names = {td.name for td in ir.typedicts}
        assert "ComplexTransformInit" in td_names
        assert "ComplexTransformOutput" in td_names

        # The service error should be extracted (TRANSFORM_FAILED is the
        # only non-protocol error, so it gets the unsuffixed name)
        assert proc.error_type is not None
        assert proc.error_type.annotation == "ComplexTransformError"

        # The union input field → str | float | TypedDict
        init_td = next(td for td in ir.typedicts if td.name == "ComplexTransformInit")
        input_field = next(f for f in init_td.fields if f.name == "input")
        assert "str" in input_field.type_ref.annotation
        assert "float" in input_field.type_ref.annotation

        # Tags array of objects
        tags_field = next((f for f in init_td.fields if f.name == "tags"), None)
        assert tags_field is not None
        assert "list[" in tags_field.type_ref.annotation
