import type { Span } from '@opentelemetry/api';
import type { DescMethod, DescService } from '@bufbuild/protobuf';
import type { ErrResult } from '../router/result';
import type { TransportClientId } from '../transport/message';
import type { SessionId } from '../transport/sessionStateMachine/common';
import type { ProtocolError } from './errors';

/**
 * Context passed to protobuf handler invocations.
 *
 * User-provided `Context` is spread into the type so handler authors can
 * access application dependencies directly (e.g. `ctx.db`). Per-service
 * `State` is available via `ctx.state`.
 */
export type ProtobufHandlerContext<
  Context extends object = object,
  State extends object = object,
  ParsedMetadata extends object = object,
> = Context & {
  /**
   * Per-service state created by {@link ProtoService}'s `initializeState`.
   */
  readonly state: State;

  /**
   * The span for the current procedure call.
   */
  readonly span: Span;

  /**
   * Metadata parsed during the transport handshake.
   */
  readonly metadata: ParsedMetadata;

  /**
   * The session this invocation belongs to.
   */
  readonly sessionId: SessionId;

  /**
   * The remote transport client id that initiated the invocation.
   */
  readonly from: TransportClientId;

  /**
   * The protobuf service being invoked.
   */
  readonly service: DescService;

  /**
   * The protobuf method being invoked.
   */
  readonly method: DescMethod;

  /**
   * Register cleanup work that should run once the invocation finishes.
   */
  readonly deferCleanup: (fn: () => void | Promise<void>) => void;

  /**
   * Cancel the invocation and notify the client with a protocol-level cancel
   * error.
   */
  readonly cancel: (message?: string) => ErrResult<ProtocolError>;

  /**
   * Aborts when the invocation finishes for any reason.
   */
  readonly signal: AbortSignal;
};
