"""IR → Python source file emitter.

Renders Jinja2 templates from the ``templates/`` directory against
a :class:`SchemaIR` to produce the generated output package.
"""

from __future__ import annotations

import os
from pathlib import Path

import jinja2

from river.codegen.schema import (
    SchemaIR,
    ServiceDef,
    _sanitize_identifier,
    _to_pascal_case,
)

_TEMPLATE_DIR = Path(__file__).parent / "templates"

_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(str(_TEMPLATE_DIR)),
    keep_trailing_newline=True,
    lstrip_blocks=True,
    trim_blocks=True,
)
_env.filters["pascal"] = _to_pascal_case


def _result_type(proc) -> str:  # noqa: ANN001
    """Build the typed result annotation for a procedure."""
    ok = f"OkResult[{proc.output_type.annotation}]"
    if proc.error_type:
        err = f"ErrResult[{proc.error_type.annotation} | ProtocolError]"
    else:
        err = "ErrResult[ProtocolError]"
    return f"{ok} | {err}"


_env.filters["result_type"] = _result_type


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _field_annotation(f) -> str:  # noqa: ANN001
    """Return the full annotation for a TypedDict field."""
    ann = f.type_ref.annotation
    if not f.required:
        return f"NotRequired[{ann}]"
    return ann


def _collect_used_type_names(svc: ServiceDef, ir: SchemaIR) -> list[str]:
    """Collect TypedDict names actually referenced in method signatures."""
    td_names = {td.name for td in ir.typedicts}
    names: set[str] = set()

    for proc in svc.procedures:
        _extract_names(proc.init_type.annotation, td_names, names)
        if proc.input_type:
            _extract_names(proc.input_type.annotation, td_names, names)
        _extract_names(proc.output_type.annotation, td_names, names)
        if proc.error_type:
            _extract_names(proc.error_type.annotation, td_names, names)

    return sorted(names)


def _extract_names(annotation: str, known: set[str], out: set[str]) -> None:
    import re

    for name in re.findall(r"[A-Za-z_]\w*", annotation):
        if name in known:
            out.add(name)


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def _prepare_typedicts(ir: SchemaIR) -> list[dict]:
    """Prepare TypedDict data for the types template."""
    result = []
    for td in ir.typedicts:
        fields = []
        for f in td.fields:
            fields.append({"name": f.name, "annotation": _field_annotation(f)})
        result.append(
            {"name": td.name, "description": td.description, "fields": fields}
        )
    return result


def render_errors() -> str:
    return _env.get_template("errors.py.j2").render()


def render_types(ir: SchemaIR) -> str:
    typedicts = _prepare_typedicts(ir)

    needs_literal = any(
        "Literal[" in f["annotation"] for td in typedicts for f in td["fields"]
    )
    has_not_required = any(
        "NotRequired[" in f["annotation"] for td in typedicts for f in td["fields"]
    )

    typing_ext = ["TypedDict"]
    if has_not_required:
        typing_ext.append("NotRequired")

    return _env.get_template("types.py.j2").render(
        typedicts=typedicts,
        needs_literal=needs_literal,
        typing_ext_imports=sorted(typing_ext),
    )


def render_service_client(svc: ServiceDef, ir: SchemaIR, import_prefix: str) -> str:
    type_names = _collect_used_type_names(svc, ir)
    types_module = "._types" if import_prefix == "." else f"{import_prefix}_types"

    proc_types = {p.proc_type for p in svc.procedures}
    has_rpc = "rpc" in proc_types
    has_stream = "stream" in proc_types
    has_upload = "upload" in proc_types
    has_subscription = "subscription" in proc_types

    # Check if any annotation references Literal (e.g. const schemas)
    all_annotations = []
    for p in svc.procedures:
        all_annotations.append(p.init_type.annotation)
        all_annotations.append(p.output_type.annotation)
        if p.input_type:
            all_annotations.append(p.input_type.annotation)
        if p.error_type:
            all_annotations.append(p.error_type.annotation)
    needs_literal = any("Literal[" in a for a in all_annotations)

    return _env.get_template("service_client.py.j2").render(
        service=svc,
        type_names=type_names,
        types_module=types_module,
        has_rpc=has_rpc,
        has_stream=has_stream,
        has_upload=has_upload,
        has_subscription=has_subscription,
        needs_literal=needs_literal,
    )


def _module_name(service_name: str) -> str:
    """Sanitize a service name for use as a Python module name."""
    return _sanitize_identifier(service_name)


def render_init(ir: SchemaIR, import_prefix: str) -> str:
    imports = []
    for svc in ir.services:
        mod_name = _module_name(svc.name)
        if import_prefix == ".":
            mod = f".{mod_name}_client"
        else:
            mod = f"{import_prefix}{mod_name}_client"
        imports.append((mod, f"{svc.class_name}Client"))

    imports.sort(key=lambda x: x[0])

    return _env.get_template("init.py.j2").render(imports=imports)


# ---------------------------------------------------------------------------
# Top-level write function
# ---------------------------------------------------------------------------


def write_generated_files(
    ir: SchemaIR,
    output_dir: str,
    package: str | None = None,
) -> list[str]:
    """Write all generated files to *output_dir*.

    Returns the list of written file paths.
    """
    os.makedirs(output_dir, exist_ok=True)
    import_prefix = f"{package}." if package else "."
    written: list[str] = []

    def _write(name: str, content: str) -> None:
        p = Path(output_dir) / name
        p.write_text(content)
        written.append(str(p))

    _write("_errors.py", render_errors())
    _write("_types.py", render_types(ir))

    for svc in ir.services:
        _write(
            f"{_module_name(svc.name)}_client.py",
            render_service_client(svc, ir, import_prefix),
        )

    _write("__init__.py", render_init(ir, import_prefix))

    return written
