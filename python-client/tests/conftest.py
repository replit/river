"""Pytest fixtures for River Python client tests.

Manages the lifecycle of a TypeScript test server process that the
Python client connects to.
"""

from __future__ import annotations

import asyncio
import os
import re
import signal
import subprocess
import sys
import time
from typing import Generator

import pytest

TESTS_DIR = os.path.dirname(__file__)
SERVER_TS = os.path.join(TESTS_DIR, "test_server.ts")
SERVER_MJS = os.path.join(TESTS_DIR, "test_server.mjs")
EXTRACT_SCHEMA_TS = os.path.join(TESTS_DIR, "extract_test_schema.ts")
EXTRACT_SCHEMA_MJS = os.path.join(TESTS_DIR, "extract_test_schema.mjs")
SCHEMA_JSON = os.path.join(TESTS_DIR, "test_schema.json")
GENERATED_DIR = os.path.join(TESTS_DIR, "generated")
RIVER_ROOT = os.path.abspath(os.path.join(TESTS_DIR, "..", ".."))
ESBUILD = os.path.join(RIVER_ROOT, "node_modules", ".bin", "esbuild")


def _esbuild_bundle(ts_path: str, mjs_path: str) -> None:
    """Bundle a .ts file to .mjs using esbuild."""
    result = subprocess.run(
        [
            ESBUILD,
            ts_path,
            "--bundle",
            "--platform=node",
            "--format=esm",
            f"--outfile={mjs_path}",
            # keep heavy deps external so the bundle stays small and
            # we reuse whatever is already in node_modules
            "--external:ws",
            "--external:@sinclair/typebox",
        ],
        cwd=RIVER_ROOT,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"esbuild failed ({result.returncode}):\n{result.stderr}")


def _build_test_server() -> None:
    """Bundle test_server.ts -> test_server.mjs using esbuild."""
    _esbuild_bundle(SERVER_TS, SERVER_MJS)


def _extract_test_schema() -> None:
    """Bundle and run extract_test_schema.ts to produce test_schema.json,
    then run codegen to produce the generated client module."""
    _esbuild_bundle(EXTRACT_SCHEMA_TS, EXTRACT_SCHEMA_MJS)
    result = subprocess.run(
        ["node", EXTRACT_SCHEMA_MJS],
        cwd=RIVER_ROOT,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"extract_test_schema failed ({result.returncode}):\n{result.stderr}"
        )

    # Run codegen
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "river.codegen",
            "--schema",
            SCHEMA_JSON,
            "--output",
            GENERATED_DIR,
        ],
        cwd=os.path.join(RIVER_ROOT, "python-client"),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"codegen failed ({result.returncode}):\n{result.stderr}\n{result.stdout}"
        )


@pytest.fixture(scope="session")
def generated_client_dir() -> str:
    """Extract test schema and run codegen. Returns the generated dir path."""
    _extract_test_schema()
    return GENERATED_DIR


@pytest.fixture(scope="session")
def event_loop():
    """Create an event loop for the entire test session."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session")
def river_server_port() -> Generator[int, None, None]:
    """Build and start the TypeScript test server, yield its port.

    The server is built once via esbuild and kept alive for the entire
    test session.
    """
    _build_test_server()

    proc = subprocess.Popen(
        ["node", SERVER_MJS],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=RIVER_ROOT,
    )

    # Wait for the server to print the port
    port = None
    deadline = time.monotonic() + 30
    assert proc.stdout is not None
    while time.monotonic() < deadline:
        line = proc.stdout.readline().decode("utf-8").strip()
        if not line:
            if proc.poll() is not None:
                stderr = proc.stderr.read().decode("utf-8") if proc.stderr else ""
                raise RuntimeError(
                    f"Test server exited with code {proc.returncode}.\nstderr: {stderr}"
                )
            time.sleep(0.1)
            continue
        m = re.match(r"RIVER_PORT=(\d+)", line)
        if m:
            port = int(m.group(1))
            break

    if port is None:
        proc.kill()
        raise RuntimeError("Failed to get port from test server within 30s")

    yield port

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture
def server_url(river_server_port: int) -> str:
    """Return the WebSocket URL for the test server."""
    return f"ws://127.0.0.1:{river_server_port}"
