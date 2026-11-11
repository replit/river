import { expect, test, vi } from 'vitest';
import { Type } from 'typebox';
import { createMockTransportNetwork } from '../testUtil';
import { waitFor } from '../testUtil/fixtures/cleanup';
import { createPromiseWithResolvers } from '../transport/promises';
import { ProtocolError, SessionState } from '../transport';

test('a validating handshake cannot connect after the server closes', async () => {
  // Risk: a client connects to a dead server and its calls hang.
  const network = createMockTransportNetwork();
  const validation = createPromiseWithResolvers<object>();
  let validating = false;
  const server = network.getServerTransport('SERVER', {
    schema: Type.Object({}),
    validate: () => {
      validating = true;

      return validation.promise;
    },
  });
  const client = network.getClientTransport('client', {
    schema: Type.Object({}),
    construct: async () => ({}),
  });
  try {
    client.connect('SERVER');
    await waitFor(() => expect(validating).toBe(true));
    server.close();
    validation.resolve({});
    await vi.advanceTimersByTimeAsync(0);
    expect(server.sessions.size).toBe(0);
    expect(server.pendingSessions.size).toBe(0);
    expect(server.getStatus()).toBe('closed');
  } finally {
    client.close();
    server.close();
    await network.cleanup();
  }
});

test('a rejecting handshake cannot crash or connect after the server closes', async () => {
  // Risk: a validation failure during shutdown must not crash the server process.
  const network = createMockTransportNetwork();
  const validation = createPromiseWithResolvers<object>();
  let validating = false;
  const server = network.getServerTransport('SERVER', {
    schema: Type.Object({}),
    validate: () => {
      validating = true;

      return validation.promise;
    },
  });
  const client = network.getClientTransport('client', {
    schema: Type.Object({}),
    construct: async () => ({}),
  });
  let connected = false;
  server.addEventListener('sessionTransition', ({ state }) => {
    if (state === SessionState.Connected) {
      connected = true;
    }
  });
  try {
    client.connect('SERVER');
    await waitFor(() => expect(validating).toBe(true));
    server.close();
    validation.reject(new Error('validation failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(connected).toBe(false);
    expect(server.sessions.size).toBe(0);
    expect(server.pendingSessions.size).toBe(0);
    expect(server.getStatus()).toBe('closed');
  } finally {
    client.close();
    server.close();
    await network.cleanup();
  }
});

test.each(['close', 'replace'] as const)(
  'a metadata rejection cannot affect a client session after %s',
  async (action) => {
    const network = createMockTransportNetwork();
    const metadata = createPromiseWithResolvers<object>();
    const construct = vi
      .fn()
      .mockImplementationOnce(() => metadata.promise)
      .mockResolvedValue({});
    const client = network.getClientTransport('client', {
      schema: Type.Object({}),
      construct,
      eager: true,
    });
    const server = network.getServerTransport('SERVER');
    const logger = vi.fn();
    const protocolError = vi.fn();
    client.bindLogger(logger, 'error');
    client.addEventListener('protocolError', protocolError);
    try {
      client.connect('SERVER');
      await waitFor(() =>
        expect(client.sessions.get('SERVER')?.state).toBe(
          SessionState.Handshaking,
        ),
      );

      if (action === 'close') {
        client.close();
      } else {
        client.hardDisconnect();
        client.connect('SERVER');
        await waitFor(() =>
          expect(client.sessions.get('SERVER')?.state).toBe(
            SessionState.Connected,
          ),
        );
      }
      const replacement = client.sessions.get('SERVER');

      metadata.reject(new Error('metadata failed'));
      await vi.advanceTimersByTimeAsync(0);

      expect(logger).not.toHaveBeenCalled();
      expect(protocolError).not.toHaveBeenCalled();
      expect(client.sessions.get('SERVER')).toBe(replacement);
      if (action === 'close') {
        expect(client.getStatus()).toBe('closed');
      } else {
        expect(replacement?.state).toBe(SessionState.Connected);
      }
    } finally {
      client.close();
      server.close();
      await network.cleanup();
    }
  },
);

test('a metadata rejection still reports a live handshake failure', async () => {
  const network = createMockTransportNetwork();
  const metadata = createPromiseWithResolvers<object>();
  const client = network.getClientTransport('client', {
    schema: Type.Object({}),
    construct: () => metadata.promise,
  });
  const server = network.getServerTransport('SERVER');
  const protocolError = vi.fn();
  client.reconnectOnConnectionDrop = false;
  client.addEventListener('protocolError', protocolError);
  try {
    client.connect('SERVER');
    await waitFor(() =>
      expect(client.sessions.get('SERVER')?.state).toBe(
        SessionState.Handshaking,
      ),
    );

    metadata.reject(new Error('metadata failed'));
    await vi.advanceTimersByTimeAsync(0);

    expect(protocolError).toHaveBeenCalledExactlyOnceWith({
      type: ProtocolError.HandshakeFailed,
      message: 'failed to construct handshake metadata: metadata failed',
    });
    expect(client.sessions.size).toBe(0);
  } finally {
    client.close();
    server.close();
    await network.cleanup();
  }
});
