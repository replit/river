"""Generated River service clients."""

from .cancel_client import CancelClient
from .fallible_client import FallibleClient
from .ordering_client import OrderingClient
from .subscribable_client import SubscribableClient
from .test_client import TestClient
from .uploadable_client import UploadableClient

__all__ = [
    "CancelClient",
    "FallibleClient",
    "OrderingClient",
    "SubscribableClient",
    "TestClient",
    "UploadableClient",
]
