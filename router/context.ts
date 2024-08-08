import { TransportClientId } from '../transport/message';
import { SessionId } from '../transport/sessionStateMachine/common';

/**
 * ServiceContext exist for the purpose of declaration merging
 * to extend the context with additional properties.
 *
 * For example:
 *
 * ```ts
 * declare module '@replit/river' {
 *   interface ServiceContext {
 *     db: Database;
 *   }
 * }
 *
 * createServer(someTransport, myServices, { extendedContext: { db: myDb } });
 * ```
 *
 * Once you do this, your {@link ProcedureHandlerContext} will have `db` property on it.
 */
/* eslint-disable-next-line @typescript-eslint/no-empty-interface */
export interface ServiceContext {}

/**
 * The parsed metadata schema for a service. This is the
 * return value of the {@link ServerHandshakeOptions.validate}
 * if the handshake extension is used.
 *
 * You should use declaration merging to extend this interface
 * with the sanitized metadata.
 *
 * ```ts
 * declare module '@replit/river' {
 *   interface ParsedMetadata {
 *     userId: number;
 *   }
 * }
 * ```
 */
/* eslint-disable-next-line @typescript-eslint/no-empty-interface */
export interface ParsedMetadata extends Record<string, unknown> {}

/**
 * This is passed to every procedure handler and contains various context-level
 * information and utilities. This may be extended, see {@link ServiceContext}
 */
export type ProcedureHandlerContext<State> = ServiceContext & {
  /**
   * State for this service as defined by the service definition.
   */
  state: State;
  /**
   * Metadata parsed on the server. See {@link ParsedMetadata}
   */
  metadata: ParsedMetadata;
  /**
   * The ID of the session that sent this request.
   */
  sessionId: SessionId;
  /**
   * The ID of the client that sent this request. There may be multiple sessions per client.
   */
  from: TransportClientId;
  /**
   * This is used to cancel the procedure call from the handler and notify the client that the
   * call was cancelled.
   *
   * Cancelling is not the same as closing procedure calls gracefully, please refer to
   * the river documentation to understand the difference between the two concepts.
   */
  cancel: () => void;
  /**
   * This signal is a standard [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)
   * triggered when the procedure invocation is done. This signal tracks the invocation/request finishing
   * for _any_ reason including the procedure invocation.
   *
   * You can use this to pass it on to asynchronous operations (such as fetch).
   *
   * You may also want to explicitly register callbacks on the
   * ['abort' event](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/abort_event)
   * as a way to cleanup after the request is finished.
   *
   * Note that (per standard AbortSignals) callbacks registered _after_ the procedure invocation
   * is done are not triggered. In such cases, you can check the "aborted" property and cleanup
   * immediately if needed.
   */
  signal: AbortSignal;
};
