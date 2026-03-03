"""Generated root client aggregating all service clients."""

from __future__ import annotations

from river.client import RiverClient
from .test_client import TestClient


class TestServer:
    """Aggregated client for all services."""

    def __init__(self, client: RiverClient) -> None:
        self._client = client
        self.test = TestClient(client)
