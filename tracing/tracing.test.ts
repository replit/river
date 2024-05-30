console.log('running first');
import { trace, context, Span } from '@opentelemetry/api';

import { describe, test, expect } from 'vitest';
import { createDummyTransportMessage, dummySession } from '../util/testHelpers';

import tracer from './index';
import * as tracing from './index';
import { OpaqueTransportMessage } from '../transport';

describe('Basic tracing tests', () => {
  test('createSessionTelemetryInfo', () => {
    const parentCtx = context.active();
    console.log(parentCtx);
    const span = tracer.startSpan('empty span', {}, parentCtx);
    const ctx = trace.setSpan(parentCtx, span);
    console.log(ctx);

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
    console.log(parentCtx);
    const span = tracer.startSpan('testing span', {}, parentCtx);
    const ctx = trace.setSpan(parentCtx, span);

    const msg = createDummyTransportMessage() as OpaqueTransportMessage;
    msg.tracing = tracing.getPropagationContext(ctx);

    void tracing.createHandlerSpan('rpc', msg, async (span) => {
      expect(
        // @ts-expect-error: hacking to get parentSpanId
        msg.tracing?.traceparent.includes(span.parentSpanId as string),
      ).toBeTruthy();
    });
  });
});
