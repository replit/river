import { context, propagation, Span, trace } from '@opentelemetry/api';
import { assert, beforeEach, describe, expect, test, vi } from 'vitest';
import { dummySession } from '../util/testHelpers';

import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { StackContextManager } from '@opentelemetry/sdk-trace-web';
import {
  cleanupTransports,
  createPostTestCleanups,
  testFinishesCleanly,
  waitFor,
} from '../__tests__/fixtures/cleanup';
import { testMatrix } from '../__tests__/fixtures/matrix';
import { TestSetupHelpers } from '../__tests__/fixtures/transports';
import tracer, {
  createHandlerSpan,
  createSessionTelemetryInfo,
  getPropagationContext,
} from './index';

describe('Basic tracing tests', () => {
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(
    new SimpleSpanProcessor(new InMemorySpanExporter()),
  );
  const contextManager = new StackContextManager();
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

    const spanMock = vi.fn<[Span]>();
    void createHandlerSpan(
      'rpc',
      'myservice',
      'myprocedure',
      'mystream',
      propagationContext,
      spanMock,
    );
    expect(spanMock).toHaveBeenCalledTimes(1);
    const createdSpan = spanMock.mock.calls[0][0];
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
  },
);
