import { beforeEach, describe, expect, test } from 'vitest';
import {
  cleanupTransports,
  createPostTestCleanups,
} from '../testUtil/fixtures/cleanup';
import { testMatrix } from '../testUtil/fixtures/matrix';
import { TestSetupHelpers } from '../testUtil/fixtures/transports';
import { Ok, Procedure, createClient, createServer } from '../router';
import { Type } from '@sinclair/typebox';
import { createServiceSchema } from '../router/services';

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

    interface ExtendedContext {
      testctx: string;
    }
    const extendedContext: ExtendedContext = {
      testctx: Math.random().toString(),
    };

    const ServiceSchema = createServiceSchema<ExtendedContext>();

    const services = {
      testservice: ServiceSchema.define({
        testrpc: Procedure.rpc({
          requestInit: Type.Object({}),
          responseData: Type.String(),
          handler: async ({ ctx }) => {
            return Ok(ctx.testctx);
          },
        }),
      }),
    };

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

    interface ExtendedContext {
      testctx: string;
    }

    const ServiceSchema = createServiceSchema<ExtendedContext>();

    const TestServiceScaffold = ServiceSchema.scaffold({
      initializeState: (ctx) => ({
        fromctx: ctx.testctx,
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
