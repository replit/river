import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { assert, beforeEach, describe, expect, test } from 'vitest';
import {
  CANCEL_CODE,
  Err,
  Ok,
  ProtoCodec,
  RiverErrorCode,
  createClient,
  createProtoService,
  createServer,
  type ClientError,
  type ErrResult,
} from '../protobuf';
import { getClientSendFn } from '../testUtil';
import { cleanupTransports } from '../testUtil/fixtures/cleanup';
import {
  CountRequestSchema,
  CountResponseSchema,
  EchoRequestSchema,
  TestService,
} from '../testUtil/fixtures/protobuf';
import {
  type TestSetupHelpers,
  transports,
} from '../testUtil/fixtures/transports';
import {
  ControlFlags,
  cancelMessage,
  type OpaqueTransportMessage,
} from '../transport/message';
import { createPromiseWithResolvers } from '../transport/promises';

const websocket = transports.find((transport) => transport.name === 'ws');
assert(websocket);

describe('retired protobuf streams', () => {
  let setup: TestSetupHelpers;
  let clientTransport: ReturnType<TestSetupHelpers['getClientTransport']>;
  let serverTransport: ReturnType<TestSetupHelpers['getServerTransport']>;
  let client: ReturnType<typeof createClient<typeof TestService>>;
  let server: ReturnType<typeof createServer>;
  let requests: Array<OpaqueTransportMessage>;
  let responses: Array<OpaqueTransportMessage>;
  let cleaned: ReturnType<typeof createPromiseWithResolvers<void>>;
  let streamError: ErrResult<ClientError> | undefined;

  beforeEach(async () => {
    requests = [];
    responses = [];
    cleaned = createPromiseWithResolvers<void>();
    streamError = undefined;
    setup = await websocket.setup({
      client: { codec: ProtoCodec },
      server: { codec: ProtoCodec, sessionDisconnectGraceMs: 0 },
    });
    clientTransport = setup.getClientTransport('client');
    serverTransport = setup.getServerTransport();
    server = createServer(serverTransport, [
      createProtoService().define(TestService, {
        echo: (request) => Ok({ text: request.text }),
        countUp: ({ request, ctx, resWritable }) => {
          ctx.deferCleanup(() => cleaned.resolve());
          resWritable.write(Ok({ value: 1 }));
          if (request.limit === 0) return;
          resWritable.close(streamError);
        },
      }),
    ]);
    serverTransport.addEventListener('message', (message) =>
      requests.push(message),
    );
    clientTransport.addEventListener('message', (message) =>
      responses.push(message),
    );
    client = createClient(
      TestService,
      clientTransport,
      serverTransport.clientId,
    );

    return async () => {
      await cleanupTransports([clientTransport, serverTransport]);
      await server.close();
      await setup.cleanup();
    };
  });

  function lastStreamId() {
    const opening = requests.filter((message) => message.serviceName).at(-1);
    assert(opening);

    return opening.streamId;
  }

  function replies(streamId: string) {
    return responses.filter((message) => message.streamId === streamId);
  }

  function cancel(streamId: string) {
    getClientSendFn(
      clientTransport,
      serverTransport,
    )(
      cancelMessage(streamId, Err({ code: CANCEL_CODE, message: 'cancelled' })),
    );
  }

  async function barrier() {
    await expect(client.echo({ text: 'sibling' })).resolves.toMatchObject({
      ok: true,
      payload: { text: 'sibling' },
    });
  }

  test('keeps the terminal error and ignores late cancellation without affecting replacement calls', async () => {
    streamError = Err({
      code: RiverErrorCode.UNAUTHENTICATED,
      message: 'controlled terminal error',
    });
    await expect(client.countUp({ limit: 1 }).collect()).resolves.toMatchObject(
      [
        { ok: true, payload: { value: 1 } },
        { ok: false, payload: { code: RiverErrorCode.UNAUTHENTICATED } },
      ],
    );
    const streamId = lastStreamId();
    expect(server.streams.has(streamId)).toBe(false);
    const terminal = replies(streamId);
    expect(terminal.map((message) => message.controlFlags)).toEqual([0, 0, 8]);

    cancel(streamId);
    cancel(streamId);
    await barrier();
    expect(replies(streamId)).toEqual(terminal);
    streamError = undefined;
    await expect(client.countUp({ limit: 1 }).collect()).resolves.toMatchObject(
      [{ ok: true, payload: { value: 1 } }],
    );
    expect(server.streams.size).toBe(0);
  });

  test('active cancellation cleans up and its post-retirement duplicate is silent', async () => {
    const controller = new AbortController();
    const iterator = client
      .countUp({ limit: 0 }, { signal: controller.signal })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { ok: true },
    });
    const streamId = lastStreamId();
    controller.abort();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { ok: false, payload: { code: CANCEL_CODE } },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await cleaned.promise;
    await barrier();
    expect(server.streams.has(streamId)).toBe(false);
    const terminal = replies(streamId);

    cancel(streamId);
    await barrier();
    expect(replies(streamId)).toEqual(terminal);
  });

  test('still rejects never-existing IDs and malformed or non-cancellation traffic after retirement', async () => {
    await barrier();
    cancel('never-opened');
    await barrier();
    expect(replies('never-opened')).toMatchObject([
      { payload: { ok: false, payload: { code: 'INVALID_REQUEST' } } },
    ]);

    await client.countUp({ limit: 1 }).collect();
    const malformedId = lastStreamId();
    getClientSendFn(
      clientTransport,
      serverTransport,
    )({
      streamId: malformedId,
      controlFlags: ControlFlags.StreamCancelBit,
      payload: { ok: false, payload: { code: CANCEL_CODE, message: 7 } },
    });
    await barrier();
    expect(replies(malformedId).at(-1)).toMatchObject({
      payload: { ok: false, payload: { code: 'INVALID_REQUEST' } },
    });

    await client.countUp({ limit: 1 }).collect();
    const dataId = lastStreamId();
    getClientSendFn(
      clientTransport,
      serverTransport,
    )({
      streamId: dataId,
      controlFlags: 0,
      payload: new Uint8Array(),
    });
    await barrier();
    expect(replies(dataId).at(-1)).toMatchObject({
      payload: { ok: false, payload: { code: 'INVALID_REQUEST' } },
    });

    await client.countUp({ limit: 1 }).collect();
    const wrongFlagsId = lastStreamId();
    getClientSendFn(
      clientTransport,
      serverTransport,
    )({
      ...cancelMessage(
        wrongFlagsId,
        Err({ code: CANCEL_CODE, message: 'cancelled' }),
      ),
      controlFlags: ControlFlags.StreamCancelBit | ControlFlags.StreamClosedBit,
    });
    await barrier();
    expect(replies(wrongFlagsId).at(-1)).toMatchObject({
      payload: { ok: false, payload: { code: 'INVALID_REQUEST' } },
    });

    await client.countUp({ limit: 1 }).collect();
    const otherErrorId = lastStreamId();
    getClientSendFn(
      clientTransport,
      serverTransport,
    )(
      cancelMessage(
        otherErrorId,
        Err({ code: 'UNCAUGHT_ERROR', message: 'not a cancel' }),
      ),
    );
    await barrier();
    expect(replies(otherErrorId).at(-1)).toMatchObject({
      payload: { ok: false, payload: { code: 'INVALID_REQUEST' } },
    });
  });

  test('reusing a retired ID still opens a call and active cancellation takes precedence over history', async () => {
    await client.echo({ text: 'original' });
    const streamId = lastStreamId();
    getClientSendFn(
      clientTransport,
      serverTransport,
    )({
      streamId,
      serviceName: TestService.typeName,
      procedureName: TestService.method.countUp.name,
      controlFlags: ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit,
      payload: toBinary(
        CountRequestSchema,
        create(CountRequestSchema, { limit: 0 }),
      ),
    });
    await barrier();
    expect(server.streams.has(streamId)).toBe(true);
    const fresh = replies(streamId).at(-1);
    assert(fresh?.payload instanceof Uint8Array);
    expect(fromBinary(CountResponseSchema, fresh.payload).value).toBe(1);
    cancel(streamId);
    await cleaned.promise;
    await barrier();
    expect(server.streams.has(streamId)).toBe(false);
  });

  test('only remembers the latest 200 retirements', async () => {
    await client.echo({ text: 'oldest' });
    const oldest = lastStreamId();
    for (let index = 1; index < 200; index++) {
      await client.echo({ text: String(index) });
    }
    const oldestReplies = replies(oldest);
    cancel(oldest);
    await barrier();
    expect(replies(oldest)).toEqual(oldestReplies);
    const newest = lastStreamId();
    const newestReplies = replies(newest);
    cancel(oldest);
    cancel(newest);
    await barrier();

    expect(replies(oldest).at(-1)).toMatchObject({
      payload: { ok: false, payload: { code: 'INVALID_REQUEST' } },
    });
    expect(replies(newest)).toEqual(newestReplies);
  });

  test('server cancellation invalidates old retirement history before its tombstone can expire', async () => {
    await server.close();
    server = createServer(
      serverTransport,
      [
        createProtoService().define(TestService, {
          echo: (request, ctx) =>
            request.text === 'cancel'
              ? ctx.cancel('server cancellation')
              : Ok({ text: request.text }),
        }),
      ],
      { maxCancelledStreamTombstonesPerSession: 1 },
    );
    const send = getClientSendFn(clientTransport, serverTransport);
    const reopen = (streamId: string, text: string) =>
      send({
        streamId,
        serviceName: TestService.typeName,
        procedureName: TestService.method.echo.name,
        controlFlags: ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit,
        payload: toBinary(
          EchoRequestSchema,
          create(EchoRequestSchema, { text }),
        ),
      });

    await client.echo({ text: 'original' });
    const reused = lastStreamId();
    reopen(reused, 'cancel');
    await barrier();
    expect(replies(reused).at(-1)).toMatchObject({
      payload: { ok: false, payload: { code: CANCEL_CODE } },
    });
    await client.echo({ text: 'cancel' });
    cancel(reused);
    await barrier();
    expect(replies(reused).at(-1)).toMatchObject({
      payload: { ok: false, payload: { code: 'INVALID_REQUEST' } },
    });
    const cancelled = replies(reused);
    reopen(reused, 'must remain tombstoned');
    await barrier();
    expect(replies(reused)).toEqual(cancelled);

    await client.echo({ text: 'retire before malformed traffic' });
    const rejected = lastStreamId();
    send({ streamId: rejected, controlFlags: 0, payload: new Uint8Array() });
    await barrier();
    const beforeEviction = replies(rejected);
    await client.echo({ text: 'cancel' });
    cancel(rejected);
    await barrier();
    expect(replies(rejected).slice(beforeEviction.length)).toMatchObject([
      { payload: { ok: false, payload: { code: 'INVALID_REQUEST' } } },
    ]);
  });

  test('retirement history does not cross peers or survive a closed session', async () => {
    await client.echo({ text: 'retire' });
    const streamId = lastStreamId();
    const terminal = replies(streamId);
    cancel(streamId);
    await barrier();
    expect(replies(streamId)).toEqual(terminal);

    const otherTransport = setup.getClientTransport('other');
    try {
      const otherReplies: Array<OpaqueTransportMessage> = [];
      otherTransport.addEventListener('message', (message) =>
        otherReplies.push(message),
      );
      const other = createClient(
        TestService,
        otherTransport,
        serverTransport.clientId,
      );
      await other.echo({ text: 'connect' });
      getClientSendFn(
        otherTransport,
        serverTransport,
      )(
        cancelMessage(
          streamId,
          Err({ code: CANCEL_CODE, message: 'cancelled' }),
        ),
      );
      await other.echo({ text: 'barrier' });
      expect(
        otherReplies.filter((message) => message.streamId === streamId),
      ).toMatchObject([
        { payload: { ok: false, payload: { code: 'INVALID_REQUEST' } } },
      ]);
    } finally {
      otherTransport.close();
    }

    const closed = createPromiseWithResolvers<void>();
    serverTransport.addEventListener('sessionStatus', function onStatus(event) {
      if (
        event.status === 'closed' &&
        event.session.to === clientTransport.clientId
      ) {
        serverTransport.removeEventListener('sessionStatus', onStatus);
        closed.resolve();
      }
    });
    clientTransport.close();
    await closed.promise;
    clientTransport = setup.getClientTransport('client');
    clientTransport.addEventListener('message', (message) =>
      responses.push(message),
    );
    client = createClient(
      TestService,
      clientTransport,
      serverTransport.clientId,
    );
    await barrier();
    cancel(streamId);
    await barrier();
    expect(replies(streamId).at(-1)).toMatchObject({
      payload: { ok: false, payload: { code: 'INVALID_REQUEST' } },
    });
  });
});
