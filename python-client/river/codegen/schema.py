"""JSON Schema → Python IR conversion.

Parses the serialized River schema (produced by serializeSchema() in TS)
into intermediate representation dataclasses that the emitter can turn
into Python source files.
"""

from __future__ import annotations

import keyword
import re
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# IR types
# ---------------------------------------------------------------------------


@dataclass
class TypeRef:
    """A reference to a Python type, either inline or named."""

    annotation: str  # e.g. "str", "int", "list[float]", "TestAddInit"


@dataclass
class TypedDictField:
    name: str
    type_ref: TypeRef
    required: bool = True
    description: str | None = None


@dataclass
class TypedDictDef:
    """A TypedDict class to be emitted."""

    name: str
    fields: list[TypedDictField] = field(default_factory=list)
    description: str | None = None


@dataclass
class ProcedureDef:
    """Describes a single procedure in a service."""

    name: str  # camelCase wire name
    py_name: str  # snake_case Python method name
    proc_type: str  # "rpc" | "stream" | "upload" | "subscription"
    init_type: TypeRef  # type annotation for init param
    input_type: TypeRef | None  # only for stream/upload
    output_type: TypeRef  # ok payload type
    error_type: TypeRef | None  # service-specific errors
    description: str | None = None


@dataclass
class ServiceDef:
    """Describes a single service."""

    name: str  # wire name
    class_name: str  # PascalCase Python class name
    procedures: list[ProcedureDef] = field(default_factory=list)


@dataclass
class SchemaIR:
    """Complete intermediate representation for the whole server schema."""

    services: list[ServiceDef] = field(default_factory=list)
    typedicts: list[TypedDictDef] = field(default_factory=list)
    handshake_type: TypedDictDef | None = None


# ---------------------------------------------------------------------------
# Protocol error codes (always present in the errors union)
# ---------------------------------------------------------------------------

PROTOCOL_ERROR_CODES = frozenset(
    {"UNCAUGHT_ERROR", "UNEXPECTED_DISCONNECT", "INVALID_REQUEST", "CANCEL"}
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _sanitize_identifier(s: str) -> str:
    """Replace characters illegal in Python identifiers with underscores."""
    # Replace dashes, spaces, and other non-alnum/non-underscore chars
    s = re.sub(r"[^a-zA-Z0-9_]", "_", s)
    # Strip leading digits so the result is a valid identifier
    s = re.sub(r"^[0-9]+", "", s)
    return s or "unnamed"


def _to_pascal_case(s: str) -> str:
    """Convert a camelCase, snake_case, or space-separated string to PascalCase."""
    s = _sanitize_identifier(s)
    # Handle snake_case or space-separated
    if "_" in s:
        words = re.split(r"_+", s)
        return "".join(word.capitalize() for word in words if word)
    # camelCase → PascalCase: just capitalize first letter
    if s:
        return s[0].upper() + s[1:]
    return s


def _to_snake_case(s: str) -> str:
    """Convert camelCase to snake_case."""
    s = _sanitize_identifier(s)
    result = re.sub(r"([A-Z])", r"_\1", s).lower()
    result = result.lstrip("_")
    if keyword.iskeyword(result):
        result += "_"
    return result


def _safe_field_name(name: str) -> str:
    """Normalize a property name into a valid Python identifier.

    Strips characters illegal in identifiers (e.g. ``$kind`` → ``kind``)
    and appends ``_`` to Python keywords.
    """
    sanitized = _sanitize_identifier(name)
    if keyword.iskeyword(sanitized):
        sanitized += "_"
    # Names starting with __ (and not ending with __) are name-mangled
    # inside class bodies — prefix with underscore to avoid that.
    if sanitized.startswith("__") and not sanitized.endswith("__"):
        sanitized = "_" + sanitized
    return sanitized


# ---------------------------------------------------------------------------
# JSON Schema → TypeRef conversion
# ---------------------------------------------------------------------------


class SchemaConverter:
    """Converts a serialized River server schema into SchemaIR."""

    def __init__(self) -> None:
        self._typedicts: list[TypedDictDef] = []
        # $id → assigned Python name (for recursive $ref resolution)
        self._id_to_name: dict[str, str] = {}
        # Track emitted TypedDict names to detect collisions
        self._td_names: set[str] = set()

    def convert(self, raw: dict) -> SchemaIR:
        """Convert the top-level serialized schema dict to IR."""
        self._typedicts = []
        self._id_to_name = {}
        self._td_names = set()
        services: list[ServiceDef] = []
        seen_modules: dict[str, str] = {}  # sanitized name → wire name
        seen_classes: dict[str, str] = {}  # class name → wire name
        for svc_name, svc_data in raw.get("services", {}).items():
            module_name = _sanitize_identifier(svc_name)
            if module_name in seen_modules:
                raise ValueError(
                    f"services {seen_modules[module_name]!r} and "
                    f"{svc_name!r} both map to Python module "
                    f"{module_name!r}_client.py"
                )
            seen_modules[module_name] = svc_name

            class_name = _to_pascal_case(svc_name) + "Client"
            if class_name in seen_classes:
                raise ValueError(
                    f"services {seen_classes[class_name]!r} and "
                    f"{svc_name!r} both map to Python class "
                    f"{class_name!r}"
                )
            seen_classes[class_name] = svc_name

            svc_def = self._convert_service(svc_name, svc_data)
            services.append(svc_def)

        # Parse optional handshake schema
        handshake_type: TypedDictDef | None = None
        hs_schema = raw.get("handshakeSchema")
        if hs_schema and isinstance(hs_schema, dict):
            self._schema_to_typeref(hs_schema, "HandshakeSchema")
            # The TypedDict was just emitted — pop it off _typedicts
            handshake_type = self._typedicts.pop()

        return SchemaIR(
            services=services,
            typedicts=list(self._typedicts),
            handshake_type=handshake_type,
        )

    def _convert_service(self, name: str, data: dict) -> ServiceDef:
        class_name = _to_pascal_case(name)
        procedures: list[ProcedureDef] = []
        seen_py_names: dict[str, str] = {}  # py_name → wire name
        for proc_name, proc_data in data.get("procedures", {}).items():
            proc_def = self._convert_procedure(class_name, proc_name, proc_data)
            if proc_def.py_name in seen_py_names:
                raise ValueError(
                    f"service {name!r}: procedures "
                    f"{seen_py_names[proc_def.py_name]!r} and "
                    f"{proc_name!r} both map to Python method "
                    f"{proc_def.py_name!r}"
                )
            seen_py_names[proc_def.py_name] = proc_name
            procedures.append(proc_def)
        return ServiceDef(
            name=name,
            class_name=class_name,
            procedures=procedures,
        )

    def _convert_procedure(self, svc_class: str, name: str, data: dict) -> ProcedureDef:
        proc_type = data["type"]
        prefix = svc_class + _to_pascal_case(name)

        # Init type and streaming input type.
        # Two schema formats:
        #   - v2 (serializeSchema): all procedures have "init"; stream/upload also have "input"
        #   - v1 (pid2 etc.): rpc/subscription use "input" as init; stream/upload have "init" + "input"
        input_type = None
        if "init" in data:
            init_type = self._schema_to_typeref(data["init"], f"{prefix}Init")
            if "input" in data:
                input_type = self._schema_to_typeref(data["input"], f"{prefix}Input")
        else:
            init_type = self._schema_to_typeref(data["input"], f"{prefix}Init")

        # Output type
        output_type = self._schema_to_typeref(data["output"], f"{prefix}Output")

        # Error type — separate protocol errors from service errors
        error_type = self._extract_service_errors(data.get("errors"), prefix)

        description = data.get("description")

        return ProcedureDef(
            name=name,
            py_name=_to_snake_case(name),
            proc_type=proc_type,
            init_type=init_type,
            input_type=input_type,
            output_type=output_type,
            error_type=error_type,
            description=description,
        )

    def _extract_service_errors(
        self, errors_schema: dict | None, prefix: str
    ) -> TypeRef | None:
        """Extract non-protocol errors from the errors union."""
        if errors_schema is None:
            return None

        variants = errors_schema.get("anyOf", [])
        service_variants = []
        for v in variants:
            code_schema = v.get("properties", {}).get("code", {})
            code_const = code_schema.get("const")
            if code_const and code_const in PROTOCOL_ERROR_CODES:
                continue
            service_variants.append(v)

        if not service_variants:
            return None

        if len(service_variants) == 1:
            return self._schema_to_typeref(service_variants[0], f"{prefix}Error")

        # Multiple service error variants → union
        refs: list[TypeRef] = []
        for i, v in enumerate(service_variants):
            code_schema = v.get("properties", {}).get("code", {})
            code_const = code_schema.get("const")
            if code_const:
                suffix = _to_pascal_case(code_const.lower().replace("_", " "))
                td_name = f"{prefix}Error{suffix}"
            else:
                td_name = f"{prefix}Error{i}"
            refs.append(self._schema_to_typeref(v, td_name))

        parts = " | ".join(r.annotation for r in refs)
        return TypeRef(annotation=parts)

    def _schema_to_typeref(self, schema: dict, name_hint: str) -> TypeRef:
        """Convert a JSON Schema node to a TypeRef, potentially creating TypedDicts."""
        if not isinstance(schema, dict):
            return TypeRef(annotation="Any")

        # $ref → forward reference to a previously-registered $id
        if "$ref" in schema:
            ref_id = schema["$ref"]
            if ref_id in self._id_to_name:
                return TypeRef(annotation=self._id_to_name[ref_id])
            return TypeRef(annotation="Never")

        # $id → register the name before converting (enables recursive refs)
        schema_id = schema.get("$id")
        if schema_id is not None:
            self._id_to_name[schema_id] = name_hint

        # const
        if "const" in schema:
            val = schema["const"]
            if isinstance(val, str):
                # Use repr to handle all escaping (quotes, backslashes,
                # control chars) then unwrap the outer quotes and re-wrap
                # with double quotes for Literal["..."] syntax.
                escaped = repr(val)[1:-1].replace('"', '\\"')
                return TypeRef(annotation=f'Literal["{escaped}"]')
            return TypeRef(annotation=f"Literal[{val!r}]")

        # anyOf (union)
        if "anyOf" in schema:
            return self._convert_union(schema, name_hint)

        # allOf (intersection) — merge object properties
        if "allOf" in schema:
            return self._convert_intersection(schema, name_hint)

        schema_type = schema.get("type")

        # Primitive types
        if schema_type == "string":
            return TypeRef(annotation="str")
        if schema_type == "number":
            return TypeRef(annotation="float")
        if schema_type == "integer":
            return TypeRef(annotation="int")
        if schema_type == "boolean":
            return TypeRef(annotation="bool")
        if schema_type == "null":
            return TypeRef(annotation="None")
        if schema_type == "Uint8Array":
            return TypeRef(annotation="bytes")

        # Array
        if schema_type == "array":
            items = schema.get("items", {})
            item_ref = self._schema_to_typeref(items, f"{name_hint}Item")
            return TypeRef(annotation=f"list[{item_ref.annotation}]")

        # Object → TypedDict (may also contain allOf to merge)
        if schema_type == "object":
            if "allOf" in schema:
                return self._convert_intersection(schema, name_hint)
            return self._convert_object(schema, name_hint)

        # Fallback
        return TypeRef(annotation="Any")

    def _emit_typedict(self, td: TypedDictDef) -> None:
        """Register a TypedDict, skipping if the same name was already emitted."""
        if td.name in self._td_names:
            return
        self._td_names.add(td.name)
        self._typedicts.append(td)

    def _convert_object(self, schema: dict, name: str) -> TypeRef:
        """Convert a JSON Schema object to a TypedDict and return a ref to it."""
        properties = schema.get("properties", {})
        required_set = set(schema.get("required", []))
        description = schema.get("description")

        fields: list[TypedDictField] = []
        seen_field_names: dict[str, str] = {}  # normalized → original
        for prop_name, prop_schema in properties.items():
            field_name = _safe_field_name(prop_name)
            if field_name in seen_field_names:
                raise ValueError(
                    f"TypedDict {name!r}: properties "
                    f"{seen_field_names[field_name]!r} and {prop_name!r} "
                    f"both normalize to field {field_name!r}"
                )
            seen_field_names[field_name] = prop_name
            nested_name = name + _to_pascal_case(prop_name)
            field_ref = self._schema_to_typeref(prop_schema, nested_name)
            field_desc = (
                prop_schema.get("description")
                if isinstance(prop_schema, dict)
                else None
            )
            fields.append(
                TypedDictField(
                    name=field_name,
                    type_ref=field_ref,
                    required=prop_name in required_set,
                    description=field_desc,
                )
            )

        td = TypedDictDef(name=name, fields=fields, description=description)
        self._emit_typedict(td)
        return TypeRef(annotation=name)

    def _convert_intersection(self, schema: dict, name_hint: str) -> TypeRef:
        """Convert a JSON Schema allOf to a merged TypedDict.

        Object variants have their properties merged into a single
        TypedDict.  A field is required if it appears in the ``required``
        list of *any* variant (intersection semantics).  Non-object
        variants and empty allOf produce ``Never`` since they represent
        unrepresentable or contradictory intersections.
        """
        variants = schema.get("allOf", [])
        if not variants:
            return TypeRef(annotation="Never")

        # Partition into object-like variants and other variants
        object_variants: list[dict] = []
        other_variants: list[dict] = []
        for v in variants:
            if not isinstance(v, dict):
                continue
            v_type = v.get("type")
            if v_type == "object" or "properties" in v:
                object_variants.append(v)
            else:
                other_variants.append(v)

        # Mixed object + non-object is contradictory (object ∩ number = ∅)
        if object_variants and other_variants:
            return TypeRef(annotation="Never")

        # Pure object intersection — merge properties
        if object_variants:
            merged_props: dict[str, dict] = {}
            merged_required: set[str] = set()
            for v in object_variants:
                for prop_name, prop_schema in v.get("properties", {}).items():
                    merged_props[prop_name] = prop_schema
                merged_required.update(v.get("required", []))

            description = schema.get("description")
            fields: list[TypedDictField] = []
            seen_field_names: dict[str, str] = {}
            for prop_name, prop_schema in merged_props.items():
                field_name = _safe_field_name(prop_name)
                if field_name in seen_field_names:
                    raise ValueError(
                        f"TypedDict {name_hint!r}: properties "
                        f"{seen_field_names[field_name]!r} and {prop_name!r} "
                        f"both normalize to field {field_name!r}"
                    )
                seen_field_names[field_name] = prop_name
                nested_name = name_hint + _to_pascal_case(prop_name)
                field_ref = self._schema_to_typeref(prop_schema, nested_name)
                field_desc = (
                    prop_schema.get("description")
                    if isinstance(prop_schema, dict)
                    else None
                )
                fields.append(
                    TypedDictField(
                        name=field_name,
                        type_ref=field_ref,
                        required=prop_name in merged_required,
                        description=field_desc,
                    )
                )
            td = TypedDictDef(name=name_hint, fields=fields, description=description)
            self._emit_typedict(td)
            return TypeRef(annotation=name_hint)

        # Only non-object variants — contradictory primitive intersection
        return TypeRef(annotation="Never")

    def _convert_union(self, schema: dict, name_hint: str) -> TypeRef:
        """Convert a JSON Schema anyOf to a Union type."""
        variants = schema.get("anyOf", [])
        if len(variants) == 0:
            return TypeRef(annotation="Never")
        if len(variants) == 1:
            return self._schema_to_typeref(variants[0], name_hint)

        refs: list[TypeRef] = []
        for i, v in enumerate(variants):
            # Try to derive a meaningful name from a const code or description
            variant_name = self._derive_variant_name(v, name_hint, i)
            refs.append(self._schema_to_typeref(v, variant_name))

        parts = " | ".join(r.annotation for r in refs)
        return TypeRef(annotation=parts)

    def _derive_variant_name(self, variant: dict, base_name: str, index: int) -> str:
        """Derive a name for a union variant."""
        # Check for a const code field
        props = variant.get("properties", {})
        code_schema = props.get("code", {})
        if isinstance(code_schema, dict) and "const" in code_schema:
            code_val = code_schema["const"]
            suffix = _to_pascal_case(
                code_val.lower().replace("_", " ").replace("-", " ")
            )
            return f"{base_name}{suffix}"

        # Check for description
        desc = variant.get("description")
        if desc:
            safe = re.sub(r"[^a-zA-Z0-9]", "", desc)
            if safe:
                return f"{base_name}{_to_pascal_case(safe)}"

        return f"{base_name}Variant{index}"
