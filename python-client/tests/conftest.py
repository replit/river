"""Pytest fixtures for River Python client tests.

Manages the lifecycle of TypeScript test server processes that the
Python client connects to.
"""

from __future__ import annotations

import os
import re
import selectors
import signal
import subprocess
import sys
import time
from typing import Generator

import pytest

from river.codec import BinaryCodec, Codec

TESTS_DIR = os.path.dirname(__file__)
SERVER_TS = os.path.join(TESTS_DIR, "test_server.ts")
SERVER_MJS = os.path.join(TESTS_DIR, "test_server.mjs")
HANDSHAKE_SERVER_TS = os.path.join(TESTS_DIR, "test_server_handshake.ts")
HANDSHAKE_SERVER_MJS = os.path.join(TESTS_DIR, "test_server_handshake.mjs")
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
            "--external:@msgpack/msgpack",
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


def _build_handshake_server() -> None:
    """Bundle test_server_handshake.ts -> test_server_handshake.mjs using esbuild."""
    _esbuild_bundle(HANDSHAKE_SERVER_TS, HANDSHAKE_SERVER_MJS)


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


def _start_server(
    mjs_path: str,
    label: str,
    env: dict[str, str] | None = None,
) -> tuple[subprocess.Popen, int]:
    """Start a Node.js server process and return (proc, port)."""
    full_env = {**os.environ, **(env or {})}
    proc = subprocess.Popen(
        ["node", mjs_path],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=RIVER_ROOT,
        env=full_env,
    )

    port = None
    deadline = time.monotonic() + 30
    assert proc.stdout is not None
    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ)
    buf = b""
    try:
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            ready = sel.select(timeout=min(remaining, 1.0))
            if not ready:
                if proc.poll() is not None:
                    stderr = proc.stderr.read().decode("utf-8") if proc.stderr else ""
                    raise RuntimeError(
                        f"{label} exited with code {proc.returncode}.\nstderr: {stderr}"
                    )
                continue
            chunk = proc.stdout.read1(4096)  # type: ignore[union-attr]
            if not chunk:
                # EOF — child closed stdout (likely exited)
                if proc.poll() is not None:
                    stderr = proc.stderr.read().decode("utf-8") if proc.stderr else ""
                    raise RuntimeError(
                        f"{label} exited with code {proc.returncode}.\nstderr: {stderr}"
                    )
                continue
            buf += chunk
            while b"\n" in buf:
                line_bytes, buf = buf.split(b"\n", 1)
                line = line_bytes.decode("utf-8").strip()
                m = re.match(r"RIVER_PORT=(\d+)", line)
                if m:
                    port = int(m.group(1))
                    break
            if port is not None:
                break
    finally:
        sel.unregister(proc.stdout)
        sel.close()

    if port is None:
        proc.kill()
        raise RuntimeError(f"Failed to get port from {label} within 30s")

    return proc, port


def _stop_server(proc: subprocess.Popen) -> None:
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture(scope="session")
def generated_client_dir() -> str:
    """Extract test schema and run codegen. Returns the generated dir path."""
    _extract_test_schema()
    return GENERATED_DIR


@pytest.fixture(scope="session")
def river_server_port() -> Generator[int, None, None]:
    """Build and start the TypeScript test server, yield its port."""
    _build_test_server()
    proc, port = _start_server(SERVER_MJS, "Test server", env={"RIVER_CODEC": "binary"})
    yield port
    _stop_server(proc)


@pytest.fixture
def server_url(river_server_port: int) -> str:
    """Return the WebSocket URL for the test server."""
    return f"ws://127.0.0.1:{river_server_port}"


@pytest.fixture(scope="session")
def river_handshake_server_port() -> Generator[int, None, None]:
    """Build and start the handshake test server, yield its port."""
    _build_handshake_server()
    proc, port = _start_server(HANDSHAKE_SERVER_MJS, "Handshake test server")
    yield port
    _stop_server(proc)


@pytest.fixture
def handshake_server_url(river_handshake_server_port: int) -> str:
    """Return the WebSocket URL for the handshake test server."""
    return f"ws://127.0.0.1:{river_handshake_server_port}"


@pytest.fixture
def codec_and_url(
    river_server_port: int,
) -> tuple[Codec, str]:
    """Return (BinaryCodec(), server_url)."""
    return BinaryCodec(), f"ws://127.0.0.1:{river_server_port}"
