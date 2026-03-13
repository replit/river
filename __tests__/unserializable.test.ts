import { beforeEach, describe, expect, test } from 'vitest';
import { Type } from 'typebox';
import {
  Procedure,
  createServiceSchema,
  Ok,
  createClient,
  createServer,
  UNEXPECTED_DISCONNECT_CODE,
} from '../router';
import { testMatrix } from '../testUtil/fixtures/matrix';
import {
  advanceFakeTimersBySessionGrace,
  cleanupTransports,
  createPostTestCleanups,
} from '../testUtil/fixtures/cleanup';
import { TestSetupHelpers } from '../testUtil/fixtures/transports';
import { readNextResult } from '../testUtil';

const ServiceSchema = createServiceSchema();

const UnserializableServiceSchema = ServiceSchema.define({
  returnSymbol: Procedure.rpc({
    requestInit: Type.Object({}),
    responseData: Type.Object({ id: Type.String() }),
    async handler() {
      return Ok({ id: 'test', extra: Symbol('unserializable') });
    },
  }),
  streamSymbol: Procedure.subscription({
    requestInit: Type.Object({}),
    responseData: Type.Object({ id: Type.String() }),
    async handler({ resWritable }) {
      resWritable.write(Ok({ id: 'test', extra: Symbol('unserializable') }));
      resWritable.close();
    },
  }),
});

describe('unserializable values in procedure handlers', () => {
  // binary codec (msgpack) throws on Symbol, causing encode failure
  // which kills the session -- only test with ws transport since mock
  // transport's setImmediate chains conflict with fake timer flushing
  describe.each(testMatrix(['ws', 'binary']))(
    'binary codec ($transport.name transport)',
    ({ transport, codec }) => {
      const opts = { codec: codec.codec };
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

      test('rpc handler returning symbol causes client disconnect', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const services = { svc: UnserializableServiceSchema };
        createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );
        addPostTestCleanup(() =>
          cleanupTransports([clientTransport, serverTransport]),
        );

        const resultPromise = client.svc.returnSymbol.rpc({});
        await advanceFakeTimersBySessionGrace();

        const result = await resultPromise;
        expect(result).toMatchObject({
          ok: false,
          payload: {
            code: UNEXPECTED_DISCONNECT_CODE,
          },
        });
      });

      test('client-side encode failure cleans up listeners', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const services = { svc: UnserializableServiceSchema };
        createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );
        addPostTestCleanup(() =>
          cleanupTransports([clientTransport, serverTransport]),
        );

        const messageListenersBefore =
          clientTransport.eventDispatcher.numberOfListeners('message');
        const sessionStatusListenersBefore =
          clientTransport.eventDispatcher.numberOfListeners('sessionStatus');

        // sending a Symbol as init payload will fail encoding on the client side
        expect(() =>
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
          client.svc.returnSymbol.rpc({ extra: Symbol('x') } as any),
        ).toThrow();

        // listeners should not leak after the failed send
        expect(
          clientTransport.eventDispatcher.numberOfListeners('message'),
        ).toEqual(messageListenersBefore);
        expect(
          clientTransport.eventDispatcher.numberOfListeners('sessionStatus'),
        ).toEqual(sessionStatusListenersBefore);
      });

      test('subscription handler writing symbol causes client disconnect', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const services = { svc: UnserializableServiceSchema };
        createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );
        addPostTestCleanup(() =>
          cleanupTransports([clientTransport, serverTransport]),
        );

        const { resReadable } = client.svc.streamSymbol.subscribe({});
        await advanceFakeTimersBySessionGrace();

        const result = await readNextResult(resReadable);
        expect(result).toMatchObject({
          ok: false,
          payload: {
            code: UNEXPECTED_DISCONNECT_CODE,
          },
        });
      });
    },
  );

  // json codec silently drops Symbol values via JSON.stringify
  describe.each(testMatrix(['all', 'naive']))(
    'json codec ($transport.name transport)',
    ({ transport, codec }) => {
      const opts = { codec: codec.codec };
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

      test('rpc handler returning symbol silently drops the value', async () => {
        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();
        const services = { svc: UnserializableServiceSchema };
        const server = createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );
        addPostTestCleanup(() =>
          cleanupTransports([clientTransport, serverTransport]),
        );

        const result = await client.svc.returnSymbol.rpc({});
        // JSON.stringify silently drops Symbol values, so the
        // response arrives with the extra symbol field missing
        expect(result).toStrictEqual({
          ok: true,
          payload: { id: 'test' },
        });

        await server.close();
      });
    },
  );
});
