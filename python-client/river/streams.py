"""Readable and Writable stream abstractions for River procedures."""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Generic, TypeVar

T = TypeVar("T")


class ReadableBrokenError(Exception):
    """Raised when a readable stream is broken."""

    pass


class Readable(Generic[T]):
    """Async readable stream for consuming procedure results.

    Supports async iteration via `async for` and explicit read via `next()`.
    """

    def __init__(self) -> None:
        self._queue: list[T] = []
        self._closed = False
        self._broken = False
        self._locked = False
        self._waiters: list[asyncio.Future[None]] = []

    def _push_value(self, value: T) -> None:
        """Push a value into the readable stream (internal use)."""
        if self._closed:
            raise RuntimeError("Cannot push to a closed readable")
        self._queue.append(value)
        self._notify_waiters()

    def _trigger_close(self) -> None:
        """Close the readable stream (internal use)."""
        if self._closed:
            raise RuntimeError("Readable already closed")
        self._closed = True
        self._notify_waiters()

    def _notify_waiters(self) -> None:
        while self._waiters:
            w = self._waiters.pop(0)
            if not w.done():
                w.set_result(None)

    def is_readable(self) -> bool:
        """Whether the stream can still be iterated (not locked or broken)."""
        return not self._locked and not self._broken

    def is_closed(self) -> bool:
        """Whether the stream has been closed."""
        return self._closed and len(self._queue) == 0

    def _has_values_in_queue(self) -> bool:
        """Whether there are buffered values waiting to be consumed."""
        return len(self._queue) > 0

    def break_(self) -> None:
        """Break the stream, discarding all queued values.

        If the stream is already closed and the queue is empty,
        this is a no-op (the stream is already done).
        """
        if self._locked and self._broken:
            return
        self._locked = True
        # If stream is already done (closed + empty), don't signal broken
        if self._closed and len(self._queue) == 0:
            self._notify_waiters()
            return
        self._broken = True
        self._queue.clear()
        self._notify_waiters()

    async def collect(self) -> list[T]:
        """Consume all values from the stream until it closes.

        Locks the stream. Raises TypeError if already locked.
        Returns the list of all values.
        """
        if self._locked:
            raise TypeError("Readable is already locked")
        self._locked = True
        results: list[T] = []
        async for item in self._iterate():
            results.append(item)
        return results

    async def next(self) -> tuple[bool, T | None]:
        """Read the next value from the stream.

        Returns (False, value) if a value is available.
        Returns (True, None) if the stream is done.
        """
        async for item in self._iterate():
            return False, item
        return True, None

    async def _iterate(self):
        """Internal async generator."""
        self._locked = True
        while True:
            if self._broken:
                yield {"ok": False, "payload": {"code": "READABLE_BROKEN", "message": "stream was broken"}}
                return

            if self._queue:
                yield self._queue.pop(0)
                continue

            if self._closed:
                return

            # Wait for more data
            loop = asyncio.get_event_loop()
            fut: asyncio.Future[None] = loop.create_future()
            self._waiters.append(fut)
            await fut

    def __aiter__(self):
        if self._locked:
            raise TypeError("Readable is already locked")
        self._locked = True
        return _ReadableIterator(self)


class _ReadableIterator:
    """Async iterator for Readable that cleans up on break/close.

    Unlike an async generator, this class handles ``__del__``
    synchronously, ensuring the queue is cleared when a for-await
    loop breaks out.
    """

    def __init__(self, readable: Readable) -> None:
        self._readable = readable
        self._done = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._done:
            raise StopAsyncIteration

        r = self._readable
        while True:
            if r._broken:
                val = {
                    "ok": False,
                    "payload": {
                        "code": "READABLE_BROKEN",
                        "message": "stream was broken",
                    },
                }
                # After yielding the broken error, the iterator is done
                self._done = True
                return val

            if r._queue:
                return r._queue.pop(0)

            if r._closed:
                raise StopAsyncIteration

            loop = asyncio.get_event_loop()
            fut: asyncio.Future[None] = loop.create_future()
            r._waiters.append(fut)
            await fut

    def __del__(self):
        # Synchronous cleanup when the iterator is GC'd (e.g. break in for-await)
        self._readable._queue.clear()


class Writable(Generic[T]):
    """Writable stream for sending procedure requests.

    Wraps a write callback and a close callback.
    """

    def __init__(
        self,
        write_cb: Callable[[T], None],
        close_cb: Callable[[], None] | None = None,
    ) -> None:
        self._write_cb = write_cb
        self._close_cb = close_cb
        self._closed = False

    def write(self, value: T) -> None:
        """Write a value to the stream."""
        if self._closed:
            raise RuntimeError("Cannot write to a closed writable")
        self._write_cb(value)

    def close(self, value: T | None = None) -> None:
        """Close the stream, optionally writing a final value."""
        if self._closed:
            return  # Idempotent
        self._closed = True
        if value is not None:
            self._write_cb(value)
        if self._close_cb:
            self._close_cb()

    def is_writable(self) -> bool:
        return not self._closed

    def is_closed(self) -> bool:
        return self._closed
