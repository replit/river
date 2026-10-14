import { expect, test, vi } from 'vitest';
import * as hegel from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';
import { createClient } from '../../router/client';
import { createServer } from '../../router/server';
import { closeAllConnections, readNextResult } from '../../testUtil';
import { cleanupTransports } from '../../testUtil/fixtures/cleanup';
import { createMockTransportNetwork } from '../../testUtil/fixtures/mockTransport';
import { TestServiceSchema } from '../../testUtil/fixtures/services';

test(
  'generated heavy feeds cannot park an unrelated stream across reconnect',
  () =>
    hegel.testAsync(
      async (tc) => {
        vi.useRealTimers();
        const mark = tc.draw(gs.integers({ minValue: 3, maxValue: 12 }));
        const count = tc.draw(
          gs.integers({ minValue: mark, maxValue: mark * 3 }),
        );
        const reconnect = tc.draw(gs.booleans());
        const options = {
          sendBufferHighWaterMark: mark,
          streamSendBufferHighWaterMark: mark,
          receiverAck: { maxMessages: 3, maxDelayMs: 20 },
          maxJitterMs: 0,
        };
        const network = createMockTransportNetwork({
          client: options,
          server: options,
        });
        const clientTransport = network.getClientTransport('client');
        const serverTransport = network.getServerTransport();
        const violations: Array<string> = [];
        for (const transport of [clientTransport, serverTransport]) {
          transport.bindLogger((text, meta) => {
            if (meta?.tags?.includes('invariant-violation')) {
              violations.push(text);
            }
          }, 'debug');
        }
        const services = { test: TestServiceSchema };
        createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );
        try {
          const heavy = client.test.echo.stream({});
          heavy.reqWritable.write({ msg: 'establish', ignore: false });
          await readNextResult(heavy.resReadable);
          if (reconnect) closeAllConnections(clientTransport);
          for (let i = 0; i < count; i++) {
            heavy.reqWritable.write({ msg: String(i), ignore: false });
          }
          const heavyReady = heavy.reqWritable.waitForWriteReady();
          const quiet = client.test.echo.stream({});
          expect(quiet.reqWritable.write({ msg: 'quiet', ignore: false })).toBe(
            true,
          );
          await quiet.reqWritable.waitForWriteReady();
          expect(await readNextResult(quiet.resReadable)).toStrictEqual({
            ok: true,
            payload: { response: 'quiet' },
          });
          await heavyReady;
          for (let i = 0; i < count; i++) {
            expect(await readNextResult(heavy.resReadable)).toStrictEqual({
              ok: true,
              payload: { response: String(i) },
            });
          }
          heavy.reqWritable.close();
          quiet.reqWritable.close();
          expect(violations).toEqual([]);
        } finally {
          await cleanupTransports([clientTransport, serverTransport]);
          await network.cleanup();
          vi.useFakeTimers({ shouldAdvanceTime: true });
        }
      },
      { testCases: 20 },
    ),
  30_000,
);
