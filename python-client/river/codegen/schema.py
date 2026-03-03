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
    """Ensure a field name is a valid Python identifier.

    Raises ValueError if the name requires sanitization that would
    change it from its wire representation, since TypedDict keys must
    match the dict keys sent on the wire.
    """
    sanitized = _sanitize_identifier(name)
    if sanitized != name:
        raise ValueError(
            f"schema property {name!r} is not a valid Python identifier "
            f"and cannot be represented in a TypedDict"
        )
    if keyword.iskeyword(name):
        raise ValueError(
            f"schema property {name!r} is a Python keyword "
            f"and cannot be used as a TypedDict field"
        )
    # Names starting with __ (and not ending with __) are name-mangled
    # inside class bodies, so the TypedDict key won't match the wire key.
    if name.startswith("__") and not name.endswith("__"):
        raise ValueError(
            f"schema property {name!r} would be name-mangled in a "
            f"TypedDict class body and cannot be used as a field"
        )
    return name


# ---------------------------------------------------------------------------
# JSON Schema → TypeRef conversion
# ---------------------------------------------------------------------------


class SchemaConverter:
    """Converts a serialized River server schema into SchemaIR."""

    def __init__(self) -> None:
        self._typedicts: list[TypedDictDef] = []
        # $id → assigned Python name (for recursive $ref resolution)
        self._id_to_name: dict[str, str] = {}

    def convert(self, raw: dict) -> SchemaIR:
        """Convert the top-level serialized schema dict to IR."""
        self._typedicts = []
        self._id_to_name = {}
        services: list[ServiceDef] = []
        for svc_name, svc_data in raw.get("services", {}).items():
            svc_def = self._convert_service(svc_name, svc_data)
            services.append(svc_def)

        return SchemaIR(services=services, typedicts=list(self._typedicts))

    def _convert_service(self, name: str, data: dict) -> ServiceDef:
        class_name = _to_pascal_case(name)
        procedures: list[ProcedureDef] = []
        for proc_name, proc_data in data.get("procedures", {}).items():
            proc_def = self._convert_procedure(class_name, proc_name, proc_data)
            procedures.append(proc_def)
        return ServiceDef(
            name=name,
            class_name=class_name,
            procedures=procedures,
        )

    def _convert_procedure(self, svc_class: str, name: str, data: dict) -> ProcedureDef:
        proc_type = data["type"]
        prefix = svc_class + _to_pascal_case(name)

        # Init type
        init_type = self._schema_to_typeref(data["init"], f"{prefix}Init")

        # Input type (only for stream/upload)
        input_type = None
        if "input" in data:
            input_type = self._schema_to_typeref(data["input"], f"{prefix}Input")

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

    def _convert_object(self, schema: dict, name: str) -> TypeRef:
        """Convert a JSON Schema object to a TypedDict and return a ref to it."""
        properties = schema.get("properties", {})
        required_set = set(schema.get("required", []))
        description = schema.get("description")

        fields: list[TypedDictField] = []
        for prop_name, prop_schema in properties.items():
            field_name = _safe_field_name(prop_name)
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
        self._typedicts.append(td)
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

        # Merge all object properties
        merged_props: dict[str, dict] = {}
        merged_required: set[str] = set()
        for v in object_variants:
            for prop_name, prop_schema in v.get("properties", {}).items():
                merged_props[prop_name] = prop_schema
            merged_required.update(v.get("required", []))

        # If we have object properties, emit a TypedDict
        if merged_props or object_variants:
            description = schema.get("description")
            fields: list[TypedDictField] = []
            for prop_name, prop_schema in merged_props.items():
                field_name = _safe_field_name(prop_name)
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
            self._typedicts.append(td)
            return TypeRef(annotation=name_hint)

        # No object variants — primitive intersection is unrepresentable
        if other_variants:
            return TypeRef(annotation="Never")

        return TypeRef(annotation="Any")

    def _convert_union(self, schema: dict, name_hint: str) -> TypeRef:
        """Convert a JSON Schema anyOf to a Union type."""
        variants = schema.get("anyOf", [])
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
