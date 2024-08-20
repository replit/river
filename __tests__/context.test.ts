import { beforeEach, describe, expect, test } from 'vitest';
import { cleanupTransports, createPostTestCleanups } from './fixtures/cleanup';
import { testMatrix } from './fixtures/matrix';
import { TestSetupHelpers } from './fixtures/transports';
import {
  Ok,
  Procedure,
  ServiceSchema,
  createClient,
  createServer,
} from '../router';
import { Type } from '@sinclair/typebox';

describe('should handle incompatabilities', async () => {
  const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
  let getClientTransport: TestSetupHelpers['getClientTransport'];
  let getServerTransport: TestSetupHelpers['getServerTransport'];
  beforeEach(async () => {
    const {
      codec: { codec },
      transport,
    } = testMatrix()[0];
    const setup = await transport.setup({
      client: { codec },
      server: { codec },
    });
    getClientTransport = setup.getClientTransport;
    getServerTransport = setup.getServerTransport;

    return async () => {
      await postTestCleanup();
      await setup.cleanup();
    };
  });

  test('should pass extended context to procedure', async () => {
    // setup
    const clientTransport = getClientTransport('client');
    const serverTransport = getServerTransport();
    const services = {
      testservice: ServiceSchema.define({
        testrpc: Procedure.rpc({
          requestInit: Type.Object({}),
          responseData: Type.String(),
          handler: async ({ ctx }) => {
            return Ok((ctx as unknown as typeof extendedContext).testctx);
          },
        }),
      }),
    };

    const extendedContext = { testctx: Math.random().toString() };
    createServer(serverTransport, services, {
      extendedContext,
    });
    const client = createClient<typeof services>(
      clientTransport,
      serverTransport.clientId,
    );
    addPostTestCleanup(async () => {
      await cleanupTransports([clientTransport, serverTransport]);
    });

    const res = await client.testservice.testrpc.rpc({});

    expect(res).toEqual({ ok: true, payload: extendedContext.testctx });
  });

  test('should pass extended context to initializeState', async () => {
    // setup
    const clientTransport = getClientTransport('client');
    const serverTransport = getServerTransport();

    const TestServiceScaffold = ServiceSchema.scaffold({
      initializeState: (ctx) => ({
        fromctx: (ctx as unknown as typeof extendedContext).testctx,
      }),
    });
    const services = {
      testservice: TestServiceScaffold.finalize({
        ...TestServiceScaffold.procedures({
          testrpc: Procedure.rpc({
            requestInit: Type.Object({}),
            responseData: Type.String(),
            handler: async ({ ctx }) => {
              return Ok(ctx.state.fromctx);
            },
          }),
        }),
      }),
    };

    const extendedContext = { testctx: Math.random().toString() };
    createServer(serverTransport, services, {
      extendedContext,
    });
    const client = createClient<typeof services>(
      clientTransport,
      serverTransport.clientId,
    );
    addPostTestCleanup(async () => {
      await cleanupTransports([clientTransport, serverTransport]);
    });

    const res = await client.testservice.testrpc.rpc({});

    expect(res).toEqual({ ok: true, payload: extendedContext.testctx });
  });
});
