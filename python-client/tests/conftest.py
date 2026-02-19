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
from typing import AsyncGenerator, Generator

import pytest
import pytest_asyncio


SERVER_SCRIPT = os.path.join(os.path.dirname(__file__), "test_server.mjs")
RIVER_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


@pytest.fixture(scope="session")
def event_loop():
    """Create an event loop for the entire test session."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture(scope="session")
def river_server_port() -> Generator[int, None, None]:
    """Start the TypeScript test server and return the port it listens on.

    The server is started once for the entire test session and killed afterward.
    """
    proc = subprocess.Popen(
        ["node", SERVER_SCRIPT],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=RIVER_ROOT,
    )

    # Wait for the server to print the port
    port = None
    deadline = time.monotonic() + 30  # 30s timeout
    assert proc.stdout is not None
    while time.monotonic() < deadline:
        line = proc.stdout.readline().decode("utf-8").strip()
        if not line:
            # Check if process died
            if proc.poll() is not None:
                stderr = proc.stderr.read().decode("utf-8") if proc.stderr else ""
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

    # Cleanup: terminate the server
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()


@pytest.fixture
def server_url(river_server_port: int) -> str:
    """Return the WebSocket URL for the test server."""
    return f"ws://127.0.0.1:{river_server_port}"
