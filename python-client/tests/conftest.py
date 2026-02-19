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
import time
from typing import Generator

import pytest


TESTS_DIR = os.path.dirname(__file__)
SERVER_TS = os.path.join(TESTS_DIR, "test_server.ts")
SERVER_MJS = os.path.join(TESTS_DIR, "test_server.mjs")
RIVER_ROOT = os.path.abspath(os.path.join(TESTS_DIR, "..", ".."))
ESBUILD = os.path.join(RIVER_ROOT, "node_modules", ".bin", "esbuild")


def _build_test_server() -> None:
    """Bundle test_server.ts -> test_server.mjs using esbuild.

    esbuild handles the river repo's bundler-style module resolution at
    build time, producing a single ESM file that plain ``node`` can run.
    """
    result = subprocess.run(
        [
            ESBUILD,
            SERVER_TS,
            "--bundle",
            "--platform=node",
            "--format=esm",
            f"--outfile={SERVER_MJS}",
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
        raise RuntimeError(
            f"esbuild failed ({result.returncode}):\n{result.stderr}"
        )


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
                stderr = (
                    proc.stderr.read().decode("utf-8") if proc.stderr else ""
                )
                raise RuntimeError(
                    f"Test server exited with code {proc.returncode}.\n"
                    f"stderr: {stderr}"
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
