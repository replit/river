import { beforeEach, describe, expect, test } from 'vitest';
import {
  closeAllConnections,
  isReadableDone,
  readNextResult,
} from '../testUtil';
import { createServer } from '../router/server';
import { createClient } from '../router/client';
import { TestServiceSchema } from '../testUtil/fixtures/services';
import {
  cleanupTransports,
  createPostTestCleanups,
  testFinishesCleanly,
  waitFor,
} from '../testUtil/fixtures/cleanup';
import { testMatrix } from '../testUtil/fixtures/matrix';
import { UNEXPECTED_DISCONNECT_CODE } from '../router';
import { TestSetupHelpers } from '../testUtil/fixtures/transports';

const HIGH_WATER_MARK = 4;

describe.each(testMatrix())(
  'writable backpressure ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = {
      codec: codec.codec,
      sendBufferHighWaterMark: HIGH_WATER_MARK,
    };

    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    let getClientTransport: TestSetupHelpers['getClientTransport'];
    let getServerTransport: TestSetupHelpers['getServerTransport'];
    beforeEach(async () => {
      const setup = await transport.setup({ client: opts, server: opts });
      getClientTransport = setup.getClientTransport;
      getServerTransport = setup.getServerTransport;

      return async () => {
        await postTestCleanup();
        await setup.cleanup();
      };
    });

    test('write reports backpressure above the high-water mark and recovers after acks', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      const { reqWritable, resReadable } = client.test.echo.stream({});

      // writing synchronously means no acks can arrive mid-loop, so the
      // buffer deterministically grows past the high-water mark (the stream
      // init message occupies a slot too)
      const results = Array.from({ length: HIGH_WATER_MARK + 1 }, (_, i) =>
        reqWritable.write({ msg: `msg${i}`, ignore: false }),
      );
      expect(results[0]).toBe(true);
      expect(results[HIGH_WATER_MARK]).toBe(false);

      // resolves once the server's responses ack our buffered messages
      await reqWritable.waitForWriteReady();

      for (let i = 0; i < HIGH_WATER_MARK + 1; i++) {
        const result = await readNextResult(resReadable);
        expect(result).toStrictEqual({
          ok: true,
          payload: { response: `msg${i}` },
        });
      }

      // everything has been acked by now, no backpressure
      expect(reqWritable.write({ msg: 'end', ignore: false })).toBe(true);
      const result = await readNextResult(resReadable);
      expect(result).toStrictEqual({
        ok: true,
        payload: { response: 'end' },
      });

      reqWritable.close();
      expect(await isReadableDone(resReadable)).toEqual(true);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('messages written under backpressure while disconnected survive a reconnect', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      const { reqWritable, resReadable } = client.test.echo.stream({});

      // make sure the stream is established and fully acked
      reqWritable.write({ msg: 'first', ignore: false });
      const first = await readNextResult(resReadable);
      expect(first).toStrictEqual({
        ok: true,
        payload: { response: 'first' },
      });

      closeAllConnections(clientTransport);

      // while disconnected nothing acks, so the buffer grows past the
      // high-water mark
      const results = Array.from({ length: HIGH_WATER_MARK + 1 }, (_, i) =>
        reqWritable.write({ msg: `buffered${i}`, ignore: false }),
      );
      expect(results[HIGH_WATER_MARK]).toBe(false);

      // resolves once the transport transparently reconnects, retransmits,
      // and the server acks
      await reqWritable.waitForWriteReady();

      // nothing was lost or reordered
      for (let i = 0; i < HIGH_WATER_MARK + 1; i++) {
        const result = await readNextResult(resReadable);
        expect(result).toStrictEqual({
          ok: true,
          payload: { response: `buffered${i}` },
        });
      }

      reqWritable.close();
      expect(await isReadableDone(resReadable)).toEqual(true);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('pending waitForWriteReady resolves when the transport closes', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      const { reqWritable, resReadable } = client.test.echo.stream({});

      closeAllConnections(clientTransport);

      // synchronously: fill the buffer past the high-water mark, park on
      // write-ready, then hard-close the transport before any reconnect
      // can drain the buffer
      const results = Array.from({ length: HIGH_WATER_MARK + 1 }, (_, i) =>
        reqWritable.write({ msg: `msg${i}`, ignore: true }),
      );
      expect(results[HIGH_WATER_MARK]).toBe(false);

      const ready = reqWritable.waitForWriteReady();
      clientTransport.close();

      // waiters are released instead of hanging forever
      await expect(ready).resolves.toBeUndefined();

      // and the writable itself is torn down
      await waitFor(() => expect(reqWritable.isWritable()).toBe(false));
      const result = await readNextResult(resReadable);
      expect(result).toStrictEqual({
        ok: false,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        payload: expect.objectContaining({ code: UNEXPECTED_DISCONNECT_CODE }),
      });
    });
  },
);
