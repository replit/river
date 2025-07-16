import { Span } from '@opentelemetry/api';
import { TransportClientId } from '../transport/message';
import { SessionId } from '../transport/sessionStateMachine/common';
import { ErrResult } from './result';
import { CancelErrorSchema, UncaughtErrorSchema } from './errors';
import { Static } from '@sinclair/typebox';

/**
 * This is passed to every procedure handler and contains various context-level
 * information and utilities.
 */
export type ProcedureHandlerContext<State, Context, ParsedMetadata> =
  Context & {
    /**
     * State for this service as defined by the service definition.
     */
    state: State;
    /**
     * The span for this procedure call. You can use this to add attributes, events, and
     * links to the span.
     */
    span: Span;
    /**
     * Metadata parsed on the server. See {@link createServerHandshakeOptions}
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
    cancel: (message?: string) => ErrResult<Static<typeof CancelErrorSchema>>;
    /**
     * This emits an uncaught error in the same way that throwing an error in a handler
     * would. You should minimize the amount of work you do after calling this function
     * as this will start a cleanup of the entire procedure call.
     *
     * You'll typically want to use this for streaming procedures, as in e.g. an RPC
     * you can just throw instead.
     */
    uncaught: (err?: unknown) => ErrResult<Static<typeof UncaughtErrorSchema>>;
    /**
     * This signal is a standard [AbortSignal](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal)
     * triggered when the procedure invocation is done. This signal tracks the invocation/request finishing
     * for _any_ reason, for example:
     * - client explicit cancellation
     * - procedure handler explicit cancellation via {@link cancel}
     * - client session disconnect
     * - server cancellation due to client invalid payload
     * - invocation finishes cleanly, this depends on the type of the procedure (i.e. rpc handler return, or in a stream after the client-side has closed the request writable and the server-side has closed the response writable)
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
