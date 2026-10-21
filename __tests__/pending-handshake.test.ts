import { expect, test, vi } from 'vitest';
import { Type } from 'typebox';
import { createMockTransportNetwork } from '../testUtil';
import { waitFor } from '../testUtil/fixtures/cleanup';
import { createPromiseWithResolvers } from '../transport/promises';

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
