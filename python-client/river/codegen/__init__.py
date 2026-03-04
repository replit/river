"""River protocol codegen — generates typed Python clients from JSON Schema."""

from river.codegen.emitter import write_generated_files
from river.codegen.schema import SchemaConverter, SchemaIR

__all__ = [
    "SchemaConverter",
    "SchemaIR",
    "write_generated_files",
]
