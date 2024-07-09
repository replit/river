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
export interface ParsedMetadata {}

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
   * An AbortController for this stream. This is used to abort the stream from the
   * handler and notify the client that the stream was aborted.
   *
   * Important to note that this controller is owned by the handler, if you
   * want to listen to aborts coming from the client, you should use the
   * {@link clientAbortSignal}.
   *
   * Aborts are not the same as closing streams gracefully, please refer to
   * the river documentation to understand the difference between the two concepts.
   */
  abortController: AbortController;
  /**
   * You can listen to clientAbortSignal this to check if the client aborted the request,
   * or if the request was aborted due to an unexpected disconnect from the calling
   * session.
   *
   * If the procedure has a read stream (e.g. upload or stream), the procedure will
   * notified of aborts as part of the stream, but you may still want to use
   * this signal as it is triggered immediately after an abort comes in,
   * in readStreams some data may be buffered before the abort result shows up.
   *
   * Important to note that this signal is owned by the client, you have a separate
   * signal inside {@link abortController} for aborts triggered within the handler.
   *
   * Aborts are not the same as closing streams gracefully, please refer to
   * the river documentation to understand the difference between the two concepts.
   */
  clientAbortSignal: AbortSignal;
  /**
   * Lets you add a function that will run when the request is done, this can be
   * due to an abort (from either side), error, or success. If the callback is
   * added after the stream ended, it will run immediately.
   */
  onRequestFinished: (callback: () => void) => void;
};
