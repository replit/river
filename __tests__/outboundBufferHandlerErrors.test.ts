import { create, toBinary } from '@bufbuild/protobuf';
import { afterEach, assert, describe, expect, test, vi } from 'vitest';
import { Type } from 'typebox';
import { NaiveJsonCodec } from '../codec';
import {
  createClient,
  createServer,
  createServiceSchema,
  Ok,
  Procedure,
  UNCAUGHT_ERROR_CODE,
  UNEXPECTED_DISCONNECT_CODE,
} from '../router';
import {
  createClient as createProtoClient,
  createServer as createProtoServer,
  createProtoService,
  ProtoCodec,
} from '../protobuf';
import {
  CountResponseSchema,
  TestService,
} from '../testUtil/fixtures/protobuf';
import { TestServiceSchema } from '../testUtil/fixtures/services';
import { transports } from '../testUtil/fixtures/transports';
import { waitFor } from '../testUtil/fixtures/cleanup';
import { generateId } from '../transport/id';
import { SessionState } from '../transport/sessionStateMachine';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.each(['typebox', 'protobuf'] as const)(
  '%s handler error reporting',
  (router) => {
    test.each(['full history', 'oversized error', 'foreign overflow'] as const)(
      '%s finishes the call without an unhandled send failure',
      async (mode) => {
        const ws = transports.find((entry) => entry.name === 'ws');
        assert(ws);
        const codec = router === 'protobuf' ? ProtoCodec : NaiveJsonCodec;
        const encodedCount: unknown = toBinary(
          CountResponseSchema,
          create(CountResponseSchema, { value: 1 }),
        );
        assert(encodedCount instanceof Uint8Array);
        const frame = {
          id: generateId(),
          from: 'SERVER',
          to: 'client',
          seq: 0,
          ack: 1,
          streamId: generateId(),
          controlFlags: 0,
          payload: router === 'protobuf' ? encodedCount : Ok({ value: 1 }),
        };
        const maxBytes =
          codec.toBuffer(frame).byteLength +
          codec.toBuffer({ ...frame, seq: 1 }).byteLength;
        const limit = {
          maxBytes,
          closeCode: 1013,
          closeReason: 'history full',
        };
        const setup = await ws.setup({
          client: { codec, nonResumableCloseCodes: [limit.closeCode] },
          server: {
            codec,
            heartbeatIntervalMs: 10000,
            ...(mode === 'foreign overflow'
              ? {}
              : { outboundBufferLimit: limit }),
          },
        });
        cleanups.push(() => setup.cleanup());
        const clientTransport = setup.getClientTransport('client');
        const serverTransport = setup.getServerTransport();
        let server:
          | { streams: ReadonlyMap<string, unknown>; close(): Promise<void> }
          | undefined;
        cleanups.push(async () => {
          clientTransport.close();
          serverTransport.close();
          await server?.close();
        });

        const upstreamSetup = await ws.setup({
          client: {
            outboundBufferLimit: {
              maxBytes: 1024,
              closeCode: 4008,
              closeReason: 'upstream full',
            },
          },
          server: { heartbeatIntervalMs: 10000 },
        });
        cleanups.push(() => upstreamSetup.cleanup());
        const upstreamTransport = upstreamSetup.getClientTransport('upstream');
        const upstreamServerTransport = upstreamSetup.getServerTransport();
        const upstreamServices = { test: TestServiceSchema };
        const upstreamServer = createServer(
          upstreamServerTransport,
          upstreamServices,
        );
        cleanups.push(async () => {
          upstreamTransport.close();
          upstreamServerTransport.close();
          await upstreamServer.close();
        });
        const upstream = createClient<typeof upstreamServices>(
          upstreamTransport,
          upstreamServerTransport.clientId,
        );
        await waitFor(() =>
          expect(
            upstreamTransport.sessions.get(upstreamServerTransport.clientId)
              ?.state,
          ).toBe(SessionState.Connected),
        );

        let signal: AbortSignal | undefined;
        let cleaned = 0;
        let acceptedBytes = 0;
        const handler = async (
          ctx: { signal: AbortSignal; deferCleanup(fn: () => void): void },
          write: (value: number) => void,
        ) => {
          signal = ctx.signal;
          ctx.deferCleanup(() => {
            cleaned++;
          });
          if (mode === 'foreign overflow') {
            await upstream.test.echoUnion.rpc({ b: 'x'.repeat(2048) });
            throw new Error('upstream unexpectedly accepted the request');
          }
          if (mode === 'full history') {
            write(1);
            write(2);
            acceptedBytes =
              serverTransport.sessions.get('client')?.outboundBuffer?.bytes ??
              0;
          }
          throw new Error(
            mode === 'oversized error' ? 'x'.repeat(2048) : 'boom',
          );
        };

        let responses: AsyncIterable<unknown>;
        if (router === 'typebox') {
          const services = {
            test: createServiceSchema().define({
              stream: Procedure.subscription({
                requestInit: Type.Object({}),
                responseData: Type.Object({ value: Type.Number() }),
                handler: ({ ctx, resWritable }) =>
                  handler(ctx, (value) => {
                    resWritable.write(Ok({ value }));
                  }),
              }),
            }),
          };
          server = createServer(serverTransport, services);
          responses = createClient<typeof services>(
            clientTransport,
            serverTransport.clientId,
          ).test.stream.subscribe({}).resReadable;
        } else {
          server = createProtoServer(serverTransport, [
            createProtoService().define(TestService, {
              countUp: ({ ctx, resWritable }) =>
                handler(ctx, (value) => {
                  resWritable.write(Ok({ value }));
                }),
            }),
          ]);
          responses = createProtoClient(
            TestService,
            clientTransport,
            serverTransport.clientId,
          ).countUp({ limit: 2 });
        }
        await waitFor(() => expect(signal?.aborted).toBe(true));
        expect(server.streams.size).toBe(0);
        expect(cleaned).toBe(1);
        if (mode === 'full history') expect(acceptedBytes).toBe(limit.maxBytes);
        const results = [];
        for await (const result of responses) results.push(result);
        expect(results).toMatchObject([
          ...(mode === 'full history'
            ? [Ok({ value: 1 }), Ok({ value: 2 })]
            : []),
          {
            ok: false,
            payload: {
              code:
                mode === 'foreign overflow'
                  ? UNCAUGHT_ERROR_CODE
                  : UNEXPECTED_DISCONNECT_CODE,
            },
          },
        ]);
        if (mode === 'foreign overflow') {
          expect(upstreamTransport.sessions.size).toBe(0);
          expect(serverTransport.sessions.size).toBe(1);
        }
        await vi.advanceTimersByTimeAsync(10);
      },
    );
  },
);
