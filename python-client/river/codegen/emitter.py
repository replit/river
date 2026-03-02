"""IR → Python source file emitter.

Renders Jinja2 templates from the ``templates/`` directory against
a :class:`SchemaIR` to produce the generated output package.
"""

from __future__ import annotations

import os
from pathlib import Path

import jinja2

from river.codegen.schema import SchemaIR, ServiceDef, _to_pascal_case

_TEMPLATE_DIR = Path(__file__).parent / "templates"

_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(str(_TEMPLATE_DIR)),
    keep_trailing_newline=True,
    lstrip_blocks=True,
    trim_blocks=True,
)
_env.filters["pascal"] = _to_pascal_case


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

    return sorted(names)


def _extract_names(annotation: str, known: set[str], out: set[str]) -> None:
    for part in annotation.replace("|", " ").split():
        clean = part.strip("[]").strip()
        if clean in known:
            out.add(clean)


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

    needs_readable = any(
        p.proc_type in ("stream", "subscription") for p in svc.procedures
    )
    needs_writable = any(p.proc_type in ("stream", "upload") for p in svc.procedures)

    wrappers = [
        p for p in svc.procedures if p.proc_type in ("stream", "upload", "subscription")
    ]

    return _env.get_template("service_client.py.j2").render(
        service=svc,
        type_names=type_names,
        types_module=types_module,
        needs_readable=needs_readable,
        needs_writable=needs_writable,
        wrappers=wrappers,
    )


def render_init(ir: SchemaIR, import_prefix: str) -> str:
    imports = []
    for svc in ir.services:
        if import_prefix == ".":
            mod = f".{svc.name}_client"
        else:
            mod = f"{import_prefix}{svc.name}_client"
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
            f"{svc.name}_client.py",
            render_service_client(svc, ir, import_prefix),
        )

    _write("__init__.py", render_init(ir, import_prefix))

    return written
