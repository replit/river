import {
  Context,
  Span,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
  Tracer,
} from '@opentelemetry/api';
import { BaseErrorSchemaType, RIVER_VERSION, ValidProcType } from '../router';
import { Connection } from '../transport';
import { MessageMetadata } from '../logging';
import { ClientSession } from '../transport/sessionStateMachine/transitions';
import { IdentifiedSession } from '../transport/sessionStateMachine/common';
import { Static } from '@sinclair/typebox';

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
  tracer: Tracer,
  sessionId: string,
  to: string,
  from: string,
  propagationCtx?: PropagationContext,
): TelemetryInfo {
  const parentCtx = propagationCtx
    ? propagation.extract(context.active(), propagationCtx)
    : context.active();

  const span = tracer.startSpan(
    `river.session.${sessionId}`,
    {
      attributes: {
        component: 'river',
        'river.session.id': sessionId,
        'river.session.to': to,
        'river.session.from': from,
      },
    },
    parentCtx,
  );

  const ctx = trace.setSpan(parentCtx, span);

  return { span, ctx };
}

export function createConnectionTelemetryInfo(
  tracer: Tracer,
  connection: Connection,
  info: TelemetryInfo,
): TelemetryInfo {
  const span = tracer.startSpan(
    `connection ${connection.id}`,
    {
      attributes: {
        component: 'river',
        'river.connection.id': connection.id,
      },
      links: [{ context: info.span.spanContext() }],
    },
    info.ctx,
  );

  const ctx = trace.setSpan(info.ctx, span);

  return { span, ctx };
}

export function createProcTelemetryInfo(
  tracer: Tracer,
  session: ClientSession<Connection>,
  kind: ValidProcType,
  serviceName: string,
  procedureName: string,
  streamId: string,
): TelemetryInfo {
  const baseCtx = context.active();
  const span = tracer.startSpan(
    `river.client.${serviceName}.${procedureName}`,
    {
      attributes: {
        component: 'river',
        'river.method.kind': kind,
        'river.method.service': serviceName,
        'river.method.name': procedureName,
        'river.streamId': streamId,
        'span.kind': 'client',
      },
      links: [{ context: session.telemetry.span.spanContext() }],
      kind: SpanKind.CLIENT,
    },
    baseCtx,
  );

  const ctx = trace.setSpan(baseCtx, span);
  const metadata: MessageMetadata = {
    ...session.loggingMetadata,
    transportMessage: {
      procedureName,
      serviceName,
    },
  };

  if (span.isRecording()) {
    metadata.telemetry = {
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
    };
  }

  session.log?.info(`invoked ${serviceName}.${procedureName}`, metadata);

  return { span, ctx };
}

export function createHandlerSpan<Fn extends (span: Span) => unknown>(
  tracer: Tracer,
  session: IdentifiedSession,
  kind: ValidProcType,
  serviceName: string,
  procedureName: string,
  streamId: string,
  tracing: PropagationContext | undefined,
  fn: Fn,
): ReturnType<Fn> {
  const ctx = tracing
    ? propagation.extract(context.active(), tracing)
    : context.active();

  return tracer.startActiveSpan<Fn>(
    `river.server.${serviceName}.${procedureName}`,
    {
      attributes: {
        component: 'river',
        'river.method.kind': kind,
        'river.method.service': serviceName,
        'river.method.name': procedureName,
        'river.streamId': streamId,
        'span.kind': 'server',
      },
      links: [{ context: session.telemetry.span.spanContext() }],
      kind: SpanKind.SERVER,
    },
    ctx,
    fn,
  );
}

export function recordRiverError(
  span: Span,
  error: Static<BaseErrorSchemaType>,
): void {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error.message,
  });
  span.setAttributes({
    'river.error_code': error.code,
    'river.error_message': error.message,
  });
}

export function getTracer(): Tracer {
  return trace.getTracer('river', RIVER_VERSION);
}
