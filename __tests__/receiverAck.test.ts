import { describe, expect, test, vi } from 'vitest';
import { createClient } from '../router/client';
import { createServer } from '../router/server';
import { readNextResult } from '../testUtil';
import { cleanupTransports, waitFor } from '../testUtil/fixtures/cleanup';
import { testMatrix } from '../testUtil/fixtures/matrix';
import { TestServiceSchema } from '../testUtil/fixtures/services';

describe.each(
  testMatrix().flatMap((entry) =>
    ['client', 'server', 'both'].map((enabled) => ({ ...entry, enabled })),
  ),
)(
  'receiver ACKs: $enabled ($transport.name, $codec.name)',
  ({ transport, codec, enabled }) => {
    test('an opt-in receiver drains one-way traffic with a legacy-mode peer', async () => {
      vi.useRealTimers();
      const receiverAck = { maxMessages: 3, maxDelayMs: 20 };
      const common = {
        codec: codec.codec,
        heartbeatIntervalMs: 30_000,
        sessionDisconnectGraceMs: 90_000,
      };
      const setup = await transport.setup({
        client: { ...common, ...(enabled !== 'server' ? { receiverAck } : {}) },
        server: { ...common, ...(enabled !== 'client' ? { receiverAck } : {}) },
      });
      const clientTransport = setup.getClientTransport('client');
      const serverTransport = setup.getServerTransport();
      const services = { test: TestServiceSchema };
      createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      try {
        const call = client.test.echo.stream({});
        for (let i = 0; i < 7; i++) {
          call.reqWritable.write({
            msg: `message-${i}`,
            ignore: enabled === 'server',
          });
        }
        if (enabled !== 'server') {
          for (let i = 0; i < 7; i++) {
            expect(await readNextResult(call.resReadable)).toStrictEqual({
              ok: true,
              payload: { response: `message-${i}` },
            });
          }
        }
        const sender = enabled === 'server' ? clientTransport : serverTransport;
        await waitFor(() => {
          const session = [...sender.sessions.values()][0];
          expect(session).toBeDefined();
          expect(session.sendBuffer.length).toBeLessThanOrEqual(1);
        });
        call.reqWritable.close();
      } finally {
        await cleanupTransports([clientTransport, serverTransport]);
        await setup.cleanup();
        vi.useFakeTimers({ shouldAdvanceTime: true });
      }
    });
  },
);
