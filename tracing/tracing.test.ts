import { trace, context, propagation, Span } from '@opentelemetry/api';
import { describe, test, expect, vi, assert, beforeEach } from 'vitest';
import { dummySession, readNextResult } from '../testUtil';

import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import tracer, {
  createSessionTelemetryInfo,
  getPropagationContext,
  createHandlerSpan,
} from './index';
import { testMatrix } from '../testUtil/fixtures/matrix';
import {
  cleanupTransports,
  testFinishesCleanly,
  waitFor,
} from '../testUtil/fixtures/cleanup';
import { TestSetupHelpers } from '../testUtil/fixtures/transports';
import { createPostTestCleanups } from '../testUtil/fixtures/cleanup';
import { FallibleServiceSchema } from '../testUtil/fixtures/services';
import { createServer } from '../router/server';
import { createClient } from '../router/client';
import { UNCAUGHT_ERROR_CODE } from '../router';

describe('Basic tracing tests', () => {
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(
    new SimpleSpanProcessor(new InMemorySpanExporter()),
  );
  const contextManager = new AsyncHooksContextManager();
  contextManager.enable();
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  test('createSessionTelemetryInfo', () => {
    const parentCtx = context.active();
    const span = tracer.startSpan('empty span', {}, parentCtx);
    const ctx = trace.setSpan(parentCtx, span);

    const propCtx = getPropagationContext(ctx);
    expect(propCtx?.traceparent).toBeTruthy();
    const session = dummySession();
    const teleInfo = createSessionTelemetryInfo(
      session.id,
      session.to,
      session.from,
      propCtx,
    );

    // @ts-expect-error: hacking to get parentSpanId
    expect(propCtx?.traceparent).toContain(teleInfo.span.parentSpanId);
    expect(
      teleInfo.ctx.getValue(
        Symbol.for('OpenTelemetry Context Key SPAN'),
      ) as Span,
    ).toBeTruthy();
  });

  test('createHandlerSpan', () => {
    const parentCtx = context.active();
    const span = tracer.startSpan('testing span', {}, parentCtx);
    const ctx = trace.setSpan(parentCtx, span);

    const propagationContext = getPropagationContext(ctx);
    expect(propagationContext?.traceparent).toBeTruthy();

    const handlerMock = vi.fn<(span: Span) => void>();
    createHandlerSpan(
      'rpc',
      'myservice',
      'myprocedure',
      'mystream',
      propagationContext,
      handlerMock,
    );
    expect(handlerMock).toHaveBeenCalledTimes(1);
    const createdSpan = handlerMock.mock.calls[0][0];
    // @ts-expect-error: hacking to get parentSpanId
    expect(createdSpan.parentSpanId).toBe(span.spanContext().spanId);
  });
});

describe.each(testMatrix())(
  'Integrated tracing tests ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
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

    test('Traces sessions and connections across network boundary', async () => {
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      clientTransport.connect(serverTransport.clientId);
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      await waitFor(() => {
        expect(clientTransport.sessions.size).toBe(1);
        expect(serverTransport.sessions.size).toBe(1);
      });

      const clientSession = clientTransport.sessions.get(
        serverTransport.clientId,
      );
      const serverSession = serverTransport.sessions.get(
        clientTransport.clientId,
      );

      assert(clientSession);
      assert(serverSession);

      const clientSpan = clientSession.telemetry.span;
      const serverSpan = serverSession.telemetry.span;

      // ensure server span is a child of client span
      // @ts-expect-error: hacking to get parentSpanId
      expect(serverSpan.parentSpanId).toBe(clientSpan.spanContext().spanId);
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('implicit telemetry gets picked up from handlers', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = {
        fallible: FallibleServiceSchema,
      };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // test
      const { reqWritable, resReadable } = client.fallible.echo.stream({});
      reqWritable.write({
        msg: 'abc',
        throwResult: false,
        throwError: true,
      });
      const result = await readNextResult(resReadable);
      expect(result).toStrictEqual({
        ok: false,
        payload: {
          code: UNCAUGHT_ERROR_CODE,
          message: 'some message',
        },
      });

      reqWritable.close();
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });
  },
);
