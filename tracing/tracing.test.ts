import {
  trace,
  context,
  propagation,
  Span,
  SpanStatusCode,
} from '@opentelemetry/api';
import { describe, test, expect, vi, assert, beforeEach } from 'vitest';
import { dummySession, readNextResult } from '../testUtil';

import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { createSessionTelemetryInfo, getPropagationContext } from './index';
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
import { LogFn } from '../logging';

const provider = new BasicTracerProvider();
const spanExporter = new InMemorySpanExporter();
provider.addSpanProcessor(new SimpleSpanProcessor(spanExporter));
const contextManager = new AsyncHooksContextManager();
contextManager.enable();
trace.setGlobalTracerProvider(provider);
context.setGlobalContextManager(contextManager);
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

describe('Basic tracing tests', () => {
  test('createSessionTelemetryInfo', () => {
    const parentCtx = context.active();
    const tracer = trace.getTracer('test');
    const span = tracer.startSpan('empty span', {}, parentCtx);
    const ctx = trace.setSpan(parentCtx, span);

    const propCtx = getPropagationContext(ctx);
    expect(propCtx?.traceparent).toBeTruthy();
    const session = dummySession();
    const teleInfo = createSessionTelemetryInfo(
      tracer,
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
      spanExporter.reset();

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
      const clientMockLogger = vi.fn<LogFn>();
      clientTransport.bindLogger(clientMockLogger, 'debug');
      const serverTransport = getServerTransport();
      const serverMockLogger = vi.fn<LogFn>();
      serverTransport.bindLogger(serverMockLogger);
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
        throwError: false,
      });
      let result = await readNextResult(resReadable);
      expect(result).toStrictEqual({
        ok: true,
        payload: {
          response: 'abc',
        },
      });

      // this isn't the first message so doesn't have telemetry info on the message itself
      reqWritable.write({
        msg: 'def',
        throwResult: false,
        throwError: true,
      });

      result = await readNextResult(resReadable);
      expect(result).toStrictEqual({
        ok: false,
        payload: {
          code: UNCAUGHT_ERROR_CODE,
          message: 'some message',
        },
      });

      // expect that both client and server loggers logged the uncaught error with the correct telemetry info
      const clientInvokeCall = clientMockLogger.mock.calls.find(
        (call) => call[0] === 'invoked fallible.echo',
      );
      const serverInvokeFail = serverMockLogger.mock.calls.find(
        (call) => call[0] === 'fallible.echo handler threw an uncaught error',
      );
      expect(clientInvokeCall?.[1]).toBeTruthy();
      expect(serverInvokeFail?.[1]).toBeTruthy();
      expect(clientInvokeCall?.[1]?.telemetry?.traceId).toStrictEqual(
        serverInvokeFail?.[1]?.telemetry?.traceId,
      );

      reqWritable.close();
      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('river errors are recorded on handler spans', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const clientMockLogger = vi.fn<LogFn>();
      clientTransport.bindLogger(clientMockLogger);
      const serverTransport = getServerTransport();
      const serverMockLogger = vi.fn<LogFn>();
      serverTransport.bindLogger(serverMockLogger);
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

      const { reqWritable, resReadable } = client.fallible.echo.stream({});

      reqWritable.write({
        msg: 'abc',
        throwResult: false,
        throwError: false,
      });
      let result = await readNextResult(resReadable);
      expect(result).toStrictEqual({
        ok: true,
        payload: {
          response: 'abc',
        },
      });

      // this isn't the first message so doesn't have telemetry info on the message itself
      reqWritable.write({
        msg: 'def',
        throwResult: false,
        throwError: true,
      });

      result = await readNextResult(resReadable);
      expect(result).toStrictEqual({
        ok: false,
        payload: {
          code: UNCAUGHT_ERROR_CODE,
          message: 'some message',
        },
      });

      const spans = spanExporter.getFinishedSpans();

      const errSpan = spans.find(
        (span) =>
          span.name === 'river.server.fallible.echo' &&
          span.status.code === SpanStatusCode.ERROR,
      );
      expect(errSpan).toBeTruthy();
      expect(errSpan?.attributes['river.error_code']).toBe(UNCAUGHT_ERROR_CODE);
      expect(errSpan?.attributes['river.error_message']).toBe('some message');

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });
  },
);
