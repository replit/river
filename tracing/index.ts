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
import { Connection, OpaqueTransportMessage, Session } from '../transport';

export interface PropagationContext {
  traceparent: string;
  tracestate: string;
}

export interface TelemetryInfo {
  span: Span;
  ctx: Context;
}

export function getPropagationContext(
  ctx: Context,
): PropagationContext | undefined {
  const tracing = {
    traceparent: '',
    tracestate: '',
  };
  propagation.inject(ctx, tracing);
  return tracing;
}

export function createSessionTelemetryInfo(
  session: Session<Connection>,
  propagationCtx?: PropagationContext,
): TelemetryInfo {
  const ctx = propagationCtx
    ? propagation.extract(context.active(), propagationCtx)
    : context.active();

  const span = tracer.startSpan(
    `session ${session.id}`,
    {
      attributes: {
        component: 'river',
        'river.session.id': session.id,
        'river.session.to': session.to,
        'river.session.from': session.from,
      },
    },
    ctx,
  );

  return { span, ctx };
}

export function createConnectionTelemetryInfo(
  connection: Connection,
  sessionSpan: Span,
): TelemetryInfo {
  const ctx = trace.setSpan(context.active(), sessionSpan);
  const span = tracer.startSpan(
    `connection ${connection.id}`,
    {
      attributes: {
        component: 'river',
        'river.connection.id': connection.id,
      },
      links: [{ context: sessionSpan.spanContext() }],
    },
    ctx,
  );

  return { span, ctx };
}

export function createProcTelemetryInfo(
  kind: ValidProcType,
  serviceName: string,
  procedureName: string,
  streamId: string,
): TelemetryInfo {
  const ctx = context.active();
  const span = tracer.startSpan(
    `procedure call ${serviceName}.${procedureName}`,
    {
      attributes: {
        component: 'river',
        'river.method.kind': kind,
        'river.method.service': serviceName,
        'river.method.name': procedureName,
        'river.streamId': streamId,
        'span.kind': 'client',
      },
      kind: SpanKind.CLIENT,
    },
    ctx,
  );

  return { span, ctx };
}

export function createHandlerSpan<Fn extends (span: Span) => unknown>(
  kind: ValidProcType,
  message: OpaqueTransportMessage,
  fn: Fn,
): ReturnType<Fn> {
  const ctx = message.tracing
    ? propagation.extract(context.active(), message.tracing)
    : context.active();

  return tracer.startActiveSpan<Fn>(
    `procedure handler ${message.serviceName}.${message.procedureName}`,
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
    ctx,
    fn,
  );
}

const tracer = trace.getTracer('river', RIVER_VERSION);
export default tracer;
