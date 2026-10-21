import { expect, test, vi } from 'vitest';
import { Type } from 'typebox';
import { createMockTransportNetwork } from '../testUtil';
import { waitFor } from '../testUtil/fixtures/cleanup';
import { createPromiseWithResolvers } from '../transport/promises';
import { SessionState } from '../transport';

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
