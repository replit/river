"""CLI entry point: python -m river.codegen

Usage:
    python -m river.codegen --schema schema.json --output generated/
"""

from __future__ import annotations

import argparse
import json

from river.codegen.emitter import write_generated_files
from river.codegen.schema import SchemaConverter


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="river.codegen",
        description="Generate typed Python clients from a River JSON schema.",
    )
    parser.add_argument(
        "--schema",
        "-s",
        required=True,
        help="Path to the serialized schema JSON file.",
    )
    parser.add_argument(
        "--output",
        "-o",
        required=True,
        help="Output directory for generated files.",
    )
    parser.add_argument(
        "--package",
        default=None,
        help="Absolute import prefix instead of relative imports.",
    )

    args = parser.parse_args(argv)

    with open(args.schema) as f:
        raw_schema = json.load(f)

    converter = SchemaConverter()
    ir = converter.convert(raw_schema)

    written = write_generated_files(ir, args.output, package=args.package)

    for path in written:
        print(f"  wrote {path}")

    print(f"Generated {len(written)} files in {args.output}")


if __name__ == "__main__":
    main()
