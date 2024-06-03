console.log('running first');
import { trace, context, propagation, Span } from '@opentelemetry/api';

import { describe, test, expect, beforeAll } from 'vitest';
import { createDummyTransportMessage, dummySession } from '../util/testHelpers';

import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { StackContextManager } from '@opentelemetry/sdk-trace-web';

import tracer from './index';
import * as tracing from './index';
import { OpaqueTransportMessage } from '../transport';

beforeAll(() => {
  const provider = new BasicTracerProvider();
  provider.addSpanProcessor(
    new SimpleSpanProcessor(new InMemorySpanExporter()),
  );
  const contextManager = new StackContextManager();
  contextManager.enable();
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(contextManager);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
});

describe('Basic tracing tests', () => {
  test('createSessionTelemetryInfo', () => {
    const parentCtx = context.active();
    const span = tracer.startSpan('empty span', {}, parentCtx);
    const ctx = trace.setSpan(parentCtx, span);

    const propCtx = tracing.getPropagationContext(ctx);

    expect(propCtx?.traceparent).toBeTruthy();

    const teleInfo = tracing.createSessionTelemetryInfo(
      dummySession(),
      propCtx,
    );

    expect(
      // @ts-expect-error: hacking to get parentSpanId
      propCtx?.traceparent.includes(teleInfo.span.parentSpanId as string),
    ).toBeTruthy();

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

    const msg = createDummyTransportMessage() as OpaqueTransportMessage;
    msg.tracing = tracing.getPropagationContext(ctx);

    expect(msg.tracing?.traceparent).toBeTruthy();

    void tracing.createHandlerSpan('rpc', msg, async (span) => {
      expect(
        // @ts-expect-error: hacking to get parentSpanId
        msg.tracing?.traceparent.includes(span.parentSpanId as string),
      ).toBeTruthy();
    });
  });
});
