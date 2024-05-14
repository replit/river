import {
  Context,
  Span,
  SpanKind,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import { version as RIVER_VERSION } from '../package.json';
import { ValidProcType } from '../router';
import { OpaqueTransportMessage } from '../transport';

// trace hierarchy
// sessions -> connections -> this is an independent set of spans
// procedures == streams -> parent for most things

export interface PropagationContext {
  traceparent: string;
  tracestate: string;
}

export function createProcSpan(
  kind: ValidProcType,
  serviceName: string,
  procedureName: string,
  streamId: string,
  ctx?: Context,
): [Span, PropagationContext] {
  const tracing = { traceparent: '', tracestate: '' };
  propagation.inject(ctx ?? context.active(), tracing);
  return [
    tracer.startSpan(`${serviceName}.${procedureName}`, {
      attributes: {
        component: 'river',
        'river.method.kind': kind,
        'river.method.service': serviceName,
        'river.method.name': procedureName,
        'river.streamId': streamId,
        'span.kind': 'client',
      },
      kind: SpanKind.CLIENT,
    }),
    tracing,
  ];
}

export function createHandlerSpan(
  kind: ValidProcType,
  message: OpaqueTransportMessage,
  fn: (span: Span) => Promise<unknown>,
) {
  const tracingContext = message.tracing
    ? propagation.extract(context.active(), message.tracing)
    : context.active();

  return tracer.startActiveSpan(
    `${message.serviceName}.${message.procedureName}`,
    {
      attributes: {
        component: 'river',
        'river.method.kind': kind,
        'river.method.service': message.serviceName,
        'river.method.name': message.procedureName,
        'river.streamId': message.streamId,
        'span.kind': 'server',
      },
      kind: SpanKind.SERVER,
    },
    tracingContext,
    fn,
  );
}

const tracer = trace.getTracer('river', RIVER_VERSION);
export default tracer;
