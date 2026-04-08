"""Generated type definitions for River services."""

from __future__ import annotations

from typing_extensions import TypedDict


class TestEchoInit(TypedDict):
    msg: str


class TestEchoOutput(TypedDict):
    response: str


class HandshakeSchema(TypedDict):
    token: str
