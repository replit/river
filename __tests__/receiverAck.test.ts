import { expect, test, vi } from 'vitest';
import { createClient } from '../router/client';
import { createServer } from '../router/server';
import { closeAllConnections, readNextResult } from '../testUtil';
import { cleanupTransports } from '../testUtil/fixtures/cleanup';
import { TestServiceSchema } from '../testUtil/fixtures/services';
import { transports } from '../testUtil/fixtures/transports';

test.each(['client', 'server'])(
  'stream isolation and reconnect work with only the %s opting in',
  async (enabled) => {
    vi.useRealTimers();
    const options = {
      streamSendBufferHighWaterMark: 4,
      receiverAck: { maxMessages: 3, maxDelayMs: 20 },
    };
    const setup = await transports[0].setup({
      client: enabled === 'client' ? options : {},
      server: enabled === 'server' ? options : {},
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
      const heavy = client.test.echo.stream({});
      heavy.reqWritable.write({ msg: 'establish', ignore: false });
      await readNextResult(heavy.resReadable);
      closeAllConnections(clientTransport);
      const writes = Array.from({ length: 6 }, (_, i) =>
        heavy.reqWritable.write({ msg: String(i), ignore: false }),
      );
      if (enabled === 'client') expect(writes[5]).toBe(false);
      const ready = heavy.reqWritable.waitForWriteReady();
      const light = client.test.echo.stream({});
      expect(light.reqWritable.write({ msg: 'light', ignore: false })).toBe(
        true,
      );
      expect(await readNextResult(light.resReadable)).toMatchObject({
        ok: true,
        payload: { response: 'light' },
      });
      await ready;
      for (let i = 0; i < 6; i++) {
        expect(await readNextResult(heavy.resReadable)).toMatchObject({
          ok: true,
          payload: { response: String(i) },
        });
      }
      heavy.reqWritable.close();
      light.reqWritable.close();
    } finally {
      await cleanupTransports([clientTransport, serverTransport]);
      await setup.cleanup();
      vi.useFakeTimers({ shouldAdvanceTime: true });
    }
  },
);
