import { Static, Type } from '@sinclair/typebox';
import { PayloadType, AnyProcedure } from './procedures';
import {
  ReaderErrorSchema,
  UNCAUGHT_ERROR_CODE,
  UNEXPECTED_DISCONNECT_CODE,
  CANCEL_CODE,
  INVALID_REQUEST_CODE,
  BaseErrorSchemaType,
  ErrResultSchema,
} from './errors';
import {
  AnyService,
  InstantiatedServiceSchemaMap,
  AnyServiceSchemaMap,
} from './services';
import {
  ControlMessagePayloadSchema,
  OpaqueTransportMessage,
  isStreamClose,
  isStreamOpen,
  ControlFlags,
  isStreamCancel,
  closeStreamMessage,
  cancelMessage,
  ProtocolVersion,
  TransportClientId,
} from '../transport/message';
import {
  ServiceContext,
  ProcedureHandlerContext,
  ParsedMetadata,
} from './context';
import { Logger } from '../logging/log';
import { Value, ValueError } from '@sinclair/typebox/value';
import { Err, Result, Ok, ErrResult } from './result';
import { EventMap } from '../transport/events';
import { coerceErrorString } from '../transport/stringifyError';
import { Span, SpanStatusCode } from '@opentelemetry/api';
import { createHandlerSpan, PropagationContext } from '../tracing';
import { ServerHandshakeOptions } from './handshake';
import { Connection } from '../transport/connection';
import { ServerTransport } from '../transport/server';
import { ReadableImpl, WritableImpl } from './streams';
import { IdentifiedSession } from '../transport/sessionStateMachine/common';
import { SessionBoundSendFn } from '../transport/transport';

type StreamId = string;

/**
 * A schema for cancel payloads sent from the client
 */
const CancelResultSchema = ErrResultSchema(
  Type.Object({
    code: Type.Literal(CANCEL_CODE),
    message: Type.String(),
  }),
);

/**
 * Represents a server with a set of services. Use {@link createServer} to create it.
 * @template Services - The type of services provided by the server.
 */
export interface Server<Services extends AnyServiceSchemaMap> {
  /**
   * Services defined for this server.
   */
  services: InstantiatedServiceSchemaMap<Services>;
  /**
   * A set of stream ids that are currently open.
   */
  streams: Map<StreamId, ProcStream>;

  close: () => Promise<void>;
}

type ProcHandlerReturn = Promise<(() => void) | void>;

interface StreamInitProps {
  // msg derived
  streamId: StreamId;
  procedureName: string;
  serviceName: string;
  initPayload: Static<PayloadType>;
  tracingCtx: PropagationContext | undefined;
  // true if the first and only message is the init payload
  // i.e. rpc and subscription
  procClosesWithInit: boolean;

  // server level
  serviceContext: ServiceContext & { state: object };
  procedure: AnyProcedure;
  sessionMetadata: ParsedMetadata;

  // transport level
  initialSession: IdentifiedSession;

  // TODO remove once clients migrate to v2
  passInitAsDataForBackwardsCompat: boolean;
}

interface ProcStream {
  streamId: StreamId;
  from: TransportClientId;
  procedureName: string;
  serviceName: string;
  sessionMetadata: ParsedMetadata;
  procedure: AnyProcedure;
  handleMsg: (msg: OpaqueTransportMessage) => void;
  handleSessionDisconnect: () => void;
}

class RiverServer<Services extends AnyServiceSchemaMap>
  implements Server<Services>
{
  private transport: ServerTransport<Connection>;
  private contextMap: Map<AnyService, ServiceContext & { state: object }>;
  private log?: Logger;

  /**
   * We create a tombstones for streams cancelled by the server
   * so that we don't hit errors when the client has inflight
   * requests it sent before it saw the cancel.
   * We track cancelled streams for every client separately, so
   * that bad clients don't affect good clients.
   */
  private serverCancelledStreams: Map<TransportClientId, LRUSet<StreamId>>;
  private maxCancelledStreamTombstonesPerSession: number;

  public streams: Map<StreamId, ProcStream>;
  public services: InstantiatedServiceSchemaMap<Services>;

  private unregisterTransportListeners: () => void;

  constructor(
    transport: ServerTransport<Connection>,
    services: Services,
    handshakeOptions?: ServerHandshakeOptions,
    extendedContext?: ServiceContext,
    maxCancelledStreamTombstonesPerSession = 200,
  ) {
    const instances: Record<string, AnyService> = {};

    this.services = instances as InstantiatedServiceSchemaMap<Services>;
    this.contextMap = new Map();

    for (const [name, service] of Object.entries(services)) {
      const instance = service.instantiate(extendedContext ?? {});
      instances[name] = instance;

      this.contextMap.set(instance, {
        ...extendedContext,
        state: instance.state,
      });
    }

    if (handshakeOptions) {
      transport.extendHandshake(handshakeOptions);
    }

    this.transport = transport;
    this.streams = new Map();
    this.serverCancelledStreams = new Map();
    this.maxCancelledStreamTombstonesPerSession =
      maxCancelledStreamTombstonesPerSession;
    this.log = transport.log;

    const handleCreatingNewStreams = (message: EventMap['message']) => {
      if (message.to !== this.transport.clientId) {
        this.log?.info(
          `got msg with destination that isn't this server, ignoring`,
          {
            clientId: this.transport.clientId,
            transportMessage: message,
          },
        );

        return;
      }

      const streamId = message.streamId;
      const stream = this.streams.get(streamId);
      if (stream) {
        stream.handleMsg(message);

        return;
      }

      // if this is a cancelled stream it's safe to ignore
      if (this.serverCancelledStreams.get(message.from)?.has(streamId)) {
        return;
      }

      // if this stream init request is invalid, don't bother creating a stream
      // and tell the client to cancel
      const newStreamProps = this.validateNewProcStream(message);
      if (!newStreamProps) {
        return;
      }

      // if its not a cancelled stream, validate and create a new stream
      this.createNewProcStream({
        ...newStreamProps,
        ...message,
      });
    };

    const handleSessionStatus = (evt: EventMap['sessionStatus']) => {
      if (evt.status !== 'disconnect') return;

      const disconnectedClientId = evt.session.to;
      this.log?.info(
        `got session disconnect from ${disconnectedClientId}, cleaning up streams`,
        evt.session.loggingMetadata,
      );

      for (const stream of this.streams.values()) {
        if (stream.from === disconnectedClientId) {
          stream.handleSessionDisconnect();
        }
      }

      this.serverCancelledStreams.delete(disconnectedClientId);
    };
    const handleTransportStatus = (evt: EventMap['transportStatus']) => {
      if (evt.status !== 'closed') return;
      this.unregisterTransportListeners();
    };

    this.unregisterTransportListeners = () => {
      this.transport.removeEventListener('message', handleCreatingNewStreams);
      this.transport.removeEventListener('sessionStatus', handleSessionStatus);
      this.transport.removeEventListener(
        'transportStatus',
        handleTransportStatus,
      );
    };

    this.transport.addEventListener('message', handleCreatingNewStreams);
    this.transport.addEventListener('sessionStatus', handleSessionStatus);
    this.transport.addEventListener('transportStatus', handleTransportStatus);
  }

  private createNewProcStream(props: StreamInitProps) {
    const {
      streamId,
      initialSession,
      procedureName,
      serviceName,
      procedure,
      sessionMetadata,
      serviceContext,
      initPayload,
      tracingCtx,
      procClosesWithInit,
      passInitAsDataForBackwardsCompat,
    } = props;

    const {
      to: from,
      loggingMetadata,
      protocolVersion,
      id: sessionId,
    } = initialSession;

    let cleanClose = true;
    const onMessage = (msg: OpaqueTransportMessage) => {
      if (msg.from !== from) {
        this.log?.error('got stream message from unexpected client', {
          ...loggingMetadata,
          transportMessage: msg,
          tags: ['invariant-violation'],
        });

        return;
      }

      if (isStreamCancelBackwardsCompat(msg.controlFlags, protocolVersion)) {
        let cancelResult: Static<typeof CancelResultSchema>;
        if (Value.Check(CancelResultSchema, msg.payload)) {
          cancelResult = msg.payload;
        } else {
          // If the payload is unexpected, then we just construct our own cancel result
          cancelResult = Err({
            code: CANCEL_CODE,
            message: 'stream cancelled, client sent invalid payload',
          });
          this.log?.warn('got stream cancel without a valid protocol error', {
            ...loggingMetadata,
            transportMessage: msg,
            validationErrors: [
              ...Value.Errors(CancelResultSchema, msg.payload),
            ],
            tags: ['invalid-request'],
          });
        }

        if (!reqReadable.isClosed()) {
          reqReadable._pushValue(cancelResult);
          closeReadable();
        }

        resWritable.close();

        return;
      }

      if (reqReadable.isClosed()) {
        this.log?.warn('received message after request stream is closed', {
          ...loggingMetadata,
          transportMessage: msg,
          tags: ['invalid-request'],
        });

        onServerCancel({
          code: INVALID_REQUEST_CODE,
          message: 'received message after request stream is closed',
        });

        return;
      }

      // normal request data for upload or stream
      if (
        'requestData' in procedure &&
        Value.Check(procedure.requestData, msg.payload)
      ) {
        reqReadable._pushValue(Ok(msg.payload));

        if (isStreamCloseBackwardsCompat(msg.controlFlags, protocolVersion)) {
          // It's atypical for any of our post-v1 clients to send a close with a
          // request payload, but it's technically legal, so we'll handle it.
          closeReadable();
        }

        return;
      }

      if (
        Value.Check(ControlMessagePayloadSchema, msg.payload) &&
        isStreamCloseBackwardsCompat(msg.controlFlags, protocolVersion)
      ) {
        // Clients typically send this shape of close for stream and upload
        // after they're done.
        closeReadable();

        return;
      }

      // We couldn't make sense of the message, it's probably a bad request
      let validationErrors: Array<ValueError>;
      let errMessage: string;
      if ('requestData' in procedure) {
        errMessage = 'expected requestData or control payload';
        validationErrors = [
          ...Value.Errors(procedure.responseData, msg.payload),
        ];
      } else {
        validationErrors = [
          ...Value.Errors(ControlMessagePayloadSchema, msg.payload),
        ];
        errMessage = 'expected control payload';
      }

      this.log?.warn(errMessage, {
        ...loggingMetadata,
        transportMessage: msg,
        validationErrors,
        tags: ['invalid-request'],
      });

      onServerCancel({
        code: INVALID_REQUEST_CODE,
        message: errMessage,
      });
    };

    const finishedController = new AbortController();
    const procStream: ProcStream = {
      from: from,
      streamId,
      procedureName,
      serviceName,
      sessionMetadata,
      procedure,
      handleMsg: onMessage,
      handleSessionDisconnect: () => {
        cleanClose = false;
        const errPayload = {
          code: UNEXPECTED_DISCONNECT_CODE,
          message: 'client unexpectedly disconnected',
        } as const;

        if (!reqReadable.isClosed()) {
          reqReadable._pushValue(Err(errPayload));
          closeReadable();
        }

        resWritable.close();
      },
    };

    const sessionScopedSend = this.transport.getSessionBoundSendFn(
      from,
      sessionId,
    );

    const cancelStream = (
      streamId: StreamId,
      payload: ErrResult<Static<typeof ReaderErrorSchema>>,
    ) => {
      this.cancelStream(from, sessionScopedSend, streamId, payload);
    };

    const onServerCancel = (e: Static<typeof ReaderErrorSchema>) => {
      if (reqReadable.isClosed() && resWritable.isClosed()) {
        // Everything already closed, no-op.
        return;
      }

      cleanClose = false;
      const result = Err(e);
      if (!reqReadable.isClosed()) {
        reqReadable._pushValue(result);
        closeReadable();
      }

      resWritable.close();
      cancelStream(streamId, result);
    };

    const cleanup = () => {
      finishedController.abort();
      this.streams.delete(streamId);
    };

    const procClosesWithResponse =
      procedure.type === 'rpc' || procedure.type === 'upload';

    const reqReadable = new ReadableImpl<
      Static<PayloadType>,
      Static<typeof ReaderErrorSchema>
    >();
    const closeReadable = () => {
      reqReadable._triggerClose();

      // TODO remove once clients migrate to v2
      if (protocolVersion === 'v1.1') {
        // in v1.1 a close in either direction should close everything
        // for upload/rpc it will handle the close after it responds
        if (!procClosesWithResponse && !resWritable.isClosed()) {
          resWritable.close();
        }
      }

      if (resWritable.isClosed()) {
        cleanup();
      }
    };

    if (passInitAsDataForBackwardsCompat) {
      reqReadable._pushValue(Ok(initPayload));
    }

    const resWritable = new WritableImpl<
      Result<Static<PayloadType>, Static<BaseErrorSchemaType>>
    >({
      writeCb: (response) => {
        sessionScopedSend({
          streamId,
          controlFlags: procClosesWithResponse
            ? getStreamCloseBackwardsCompat(protocolVersion)
            : 0,
          payload: response,
        });

        if (procClosesWithResponse) {
          resWritable.close();
        }
      },
      // close callback
      closeCb: () => {
        if (!procClosesWithResponse && cleanClose) {
          // we ended, send a close bit back to the client
          // also, if the client has disconnected, we don't need to send a close

          const message = closeStreamMessage(streamId);
          // TODO remove once clients migrate to v2
          message.controlFlags = getStreamCloseBackwardsCompat(protocolVersion);

          sessionScopedSend(message);
        }

        // TODO remove once clients migrate to v2
        if (protocolVersion === 'v1.1') {
          // in v1.1 a close in either direction should close everything
          if (!reqReadable.isClosed()) {
            closeReadable();
          }
        }

        if (reqReadable.isClosed()) {
          cleanup();
        }
      },
    });

    const onHandlerError = (err: unknown, span: Span) => {
      const errorMsg = coerceErrorString(err);

      span.recordException(err instanceof Error ? err : new Error(errorMsg));
      span.setStatus({ code: SpanStatusCode.ERROR });

      this.log?.error(
        `${serviceName}.${procedureName} handler threw an uncaught error`,
        {
          ...loggingMetadata,
          transportMessage: {
            procedureName,
            serviceName,
          },
          extras: {
            error: errorMsg,
            originalException: err,
          },
          tags: ['uncaught-handler-error'],
        },
      );

      onServerCancel({
        code: UNCAUGHT_ERROR_CODE,
        message: errorMsg,
      });
    };

    // if the init message has a close flag then we know this stream
    // only consists of an init message and we shouldn't expect follow up data
    if (procClosesWithInit) {
      closeReadable();
    }

    const handlerContext: ProcedureHandlerContext<object> = {
      ...serviceContext,
      from: from,
      sessionId,
      metadata: sessionMetadata,
      cancel: () => {
        onServerCancel({
          code: CANCEL_CODE,
          message: 'cancelled by server procedure handler',
        });
      },
      signal: finishedController.signal,
    };

    switch (procedure.type) {
      case 'rpc':
        void createHandlerSpan(
          procedure.type,
          serviceName,
          procedureName,
          streamId,
          tracingCtx,
          async (span): ProcHandlerReturn => {
            try {
              const responsePayload = await procedure.handler({
                ctx: handlerContext,
                reqInit: initPayload,
              });

              if (resWritable.isClosed()) {
                // A disconnect happened
                return;
              }

              resWritable.write(responsePayload);
            } catch (err) {
              onHandlerError(err, span);
            } finally {
              span.end();
            }
          },
        );
        break;
      case 'stream':
        void createHandlerSpan(
          procedure.type,
          serviceName,
          procedureName,
          streamId,
          tracingCtx,
          async (span): ProcHandlerReturn => {
            try {
              await procedure.handler({
                ctx: handlerContext,
                reqInit: initPayload,
                reqReadable,
                resWritable,
              });
            } catch (err) {
              onHandlerError(err, span);
            } finally {
              span.end();
            }
          },
        );

        break;
      case 'subscription':
        void createHandlerSpan(
          procedure.type,
          serviceName,
          procedureName,
          streamId,
          tracingCtx,
          async (span): ProcHandlerReturn => {
            try {
              await procedure.handler({
                ctx: handlerContext,
                reqInit: initPayload,
                resWritable: resWritable,
              });
            } catch (err) {
              onHandlerError(err, span);
            } finally {
              span.end();
            }
          },
        );
        break;
      case 'upload':
        void createHandlerSpan(
          procedure.type,
          serviceName,
          procedureName,
          streamId,
          tracingCtx,
          async (span): ProcHandlerReturn => {
            try {
              const responsePayload = await procedure.handler({
                ctx: handlerContext,
                reqInit: initPayload,
                reqReadable: reqReadable,
              });

              if (resWritable.isClosed()) {
                // A disconnect happened
                return;
              }

              resWritable.write(responsePayload);
            } catch (err) {
              onHandlerError(err, span);
            } finally {
              span.end();
            }
          },
        );

        break;
    }

    if (!finishedController.signal.aborted) {
      this.streams.set(streamId, procStream);
    }
  }

  private getContext(service: AnyService, serviceName: string) {
    const context = this.contextMap.get(service);
    if (!context) {
      const err = `no context found for ${serviceName}`;
      this.log?.error(err, {
        clientId: this.transport.clientId,
        tags: ['invariant-violation'],
      });
      throw new Error(err);
    }

    return context;
  }

  private validateNewProcStream(
    initMessage: OpaqueTransportMessage,
  ): StreamInitProps | null {
    // lifetime safety: this is a sync function so this session cant transition
    // to another state before we finish
    const session = this.transport._sessions.get(initMessage.from);
    if (!session) {
      // this should be impossible, how did we receive a message from a session that doesn't exist?
      // log anyways
      this.log?.error(`couldn't find session for ${initMessage.from}`, {
        clientId: this.transport.clientId,
        transportMessage: initMessage,
        tags: ['invariant-violation'],
      });

      return null;
    }

    const sessionScopedSend = this.transport.getSessionBoundSendFn(
      initMessage.from,
      session.id,
    );

    const cancelStream = (
      streamId: StreamId,
      payload: ErrResult<Static<typeof ReaderErrorSchema>>,
    ) => {
      this.cancelStream(initMessage.from, sessionScopedSend, streamId, payload);
    };

    const sessionMetadata = this.transport.sessionHandshakeMetadata.get(
      session.to,
    );

    if (!sessionMetadata) {
      const errMessage = `session doesn't have handshake metadata`;
      this.log?.error(errMessage, {
        ...session.loggingMetadata,
        tags: ['invariant-violation'],
      });

      cancelStream(
        initMessage.streamId,
        Err({
          code: UNCAUGHT_ERROR_CODE,
          message: errMessage,
        }),
      );

      return null;
    }

    if (!isStreamOpen(initMessage.controlFlags)) {
      const errMessage = `can't create a new procedure stream from a message that doesn't have the stream open bit set`;
      this.log?.warn(errMessage, {
        ...session.loggingMetadata,
        clientId: this.transport.clientId,
        transportMessage: initMessage,
        tags: ['invalid-request'],
      });

      cancelStream(
        initMessage.streamId,
        Err({
          code: INVALID_REQUEST_CODE,
          message: errMessage,
        }),
      );

      return null;
    }

    if (!initMessage.serviceName) {
      const errMessage = `missing service name in stream open message`;
      this.log?.warn(errMessage, {
        ...session.loggingMetadata,
        transportMessage: initMessage,
        tags: ['invalid-request'],
      });

      cancelStream(
        initMessage.streamId,
        Err({
          code: INVALID_REQUEST_CODE,
          message: errMessage,
        }),
      );

      return null;
    }

    if (!initMessage.procedureName) {
      const errMessage = `missing procedure name in stream open message`;
      this.log?.warn(errMessage, {
        ...session.loggingMetadata,
        transportMessage: initMessage,
        tags: ['invalid-request'],
      });

      cancelStream(
        initMessage.streamId,
        Err({
          code: INVALID_REQUEST_CODE,
          message: errMessage,
        }),
      );

      return null;
    }

    if (!(initMessage.serviceName in this.services)) {
      const errMessage = `couldn't find service ${initMessage.serviceName}`;
      this.log?.warn(errMessage, {
        ...session.loggingMetadata,
        clientId: this.transport.clientId,
        transportMessage: initMessage,
        tags: ['invalid-request'],
      });

      cancelStream(
        initMessage.streamId,
        Err({
          code: INVALID_REQUEST_CODE,
          message: errMessage,
        }),
      );

      return null;
    }

    const service = this.services[initMessage.serviceName];
    if (!(initMessage.procedureName in service.procedures)) {
      const errMessage = `couldn't find a matching procedure for ${initMessage.serviceName}.${initMessage.procedureName}`;
      this.log?.warn(errMessage, {
        ...session.loggingMetadata,
        transportMessage: initMessage,
        tags: ['invalid-request'],
      });

      cancelStream(
        initMessage.streamId,
        Err({
          code: INVALID_REQUEST_CODE,
          message: errMessage,
        }),
      );

      return null;
    }

    const serviceContext = this.getContext(service, initMessage.serviceName);

    const procedure: AnyProcedure =
      service.procedures[initMessage.procedureName];

    if (!['rpc', 'upload', 'stream', 'subscription'].includes(procedure.type)) {
      this.log?.error(
        `got request for invalid procedure type ${procedure.type} at ${initMessage.serviceName}.${initMessage.procedureName}`,
        {
          ...session.loggingMetadata,
          transportMessage: initMessage,
          tags: ['invariant-violation'],
        },
      );

      return null;
    }

    let passInitAsDataForBackwardsCompat = false;
    if (
      session.protocolVersion === 'v1.1' &&
      (procedure.type === 'upload' || procedure.type === 'stream') &&
      Value.Check(procedure.requestData, initMessage.payload) &&
      Value.Check(procedure.requestInit, {})
    ) {
      // TODO remove once clients migrate to v2
      // In v1.1 sometimes the first message is not `init`, but instead it's the `input`
      // this backwards compatibility path requires procedures to define their `init` as
      // an empty-object-compatible-schema (i.e. either actually empty or optional values)
      // The reason we don't check if `init` is satisified here is because false positives
      // are easy to hit, we'll err on the side of caution and treat it as a request, servers
      // that expect v1.1 clients should handle this case themselves.
      passInitAsDataForBackwardsCompat = true;
    } else if (!Value.Check(procedure.requestInit, initMessage.payload)) {
      const errMessage = `procedure init failed validation`;
      this.log?.warn(errMessage, {
        ...session.loggingMetadata,
        clientId: this.transport.clientId,
        transportMessage: initMessage,
        tags: ['invalid-request'],
      });

      cancelStream(
        initMessage.streamId,
        Err({
          code: INVALID_REQUEST_CODE,
          message: errMessage,
        }),
      );

      return null;
    }

    return {
      initialSession: session,
      streamId: initMessage.streamId,
      procedureName: initMessage.procedureName,
      serviceName: initMessage.serviceName,
      tracingCtx: initMessage.tracing,
      initPayload: initMessage.payload,
      sessionMetadata,
      procedure,
      serviceContext,
      procClosesWithInit: isStreamCloseBackwardsCompat(
        initMessage.controlFlags,
        session.protocolVersion,
      ),
      passInitAsDataForBackwardsCompat,
    };
  }

  cancelStream(
    to: TransportClientId,
    sessionScopedSend: SessionBoundSendFn,
    streamId: StreamId,
    payload: ErrResult<Static<typeof ReaderErrorSchema>>,
  ) {
    let cancelledStreamsInSession = this.serverCancelledStreams.get(to);
    if (!cancelledStreamsInSession) {
      cancelledStreamsInSession = new LRUSet(
        this.maxCancelledStreamTombstonesPerSession,
      );

      this.serverCancelledStreams.set(to, cancelledStreamsInSession);
    }

    cancelledStreamsInSession.add(streamId);
    const msg = cancelMessage(streamId, payload);
    sessionScopedSend(msg);
  }

  async close() {
    this.unregisterTransportListeners();

    for (const serviceName of Object.keys(this.services)) {
      const service = this.services[serviceName];
      await service[Symbol.asyncDispose]();
    }
  }
}

class LRUSet<T> {
  private items: Set<T>;
  private maxItems: number;

  constructor(maxItems: number) {
    this.items = new Set();
    this.maxItems = maxItems;
  }

  add(item: T) {
    if (this.items.has(item)) {
      this.items.delete(item);
    } else if (this.items.size >= this.maxItems) {
      const first = this.items.values().next();
      if (!first.done) {
        this.items.delete(first.value);
      }
    }
    this.items.add(item);
  }

  has(item: T) {
    return this.items.has(item);
  }
}

// TODO remove once clients migrate to v2
function isStreamCancelBackwardsCompat(
  controlFlags: ControlFlags,
  protocolVersion: ProtocolVersion,
) {
  if (protocolVersion === 'v1.1') {
    // in 1.1 we don't have abort
    return false;
  }

  return isStreamCancel(controlFlags);
}

// TODO remove once clients migrate to v2
function isStreamCloseBackwardsCompat(
  controlFlags: ControlFlags,
  protocolVersion: ProtocolVersion,
) {
  if (protocolVersion === 'v1.1') {
    // in v1.1 the bits for close is what we use for cancel now
    return isStreamCancel(controlFlags);
  }

  return isStreamClose(controlFlags);
}

// TODO remove once clients migrate to v2
function getStreamCloseBackwardsCompat(protocolVersion: ProtocolVersion) {
  if (protocolVersion === 'v1.1') {
    // in v1.1 the bits for close is what we use for cancel now
    return ControlFlags.StreamCancelBit;
  }

  return ControlFlags.StreamClosedBit;
}

/**
 * Creates a server instance that listens for incoming messages from a transport and routes them to the appropriate service and procedure.
 * The server tracks the state of each service along with open streams and the extended context object.
 * @param transport - The transport to listen to.
 * @param services - An object containing all the services to be registered on the server.
 * @param handshakeOptions - An optional object containing additional handshake options to be passed to the transport.
 * @param extendedContext - An optional object containing additional context to be passed to all services.
 * @returns A promise that resolves to a server instance with the registered services.
 */
export function createServer<Services extends AnyServiceSchemaMap>(
  transport: ServerTransport<Connection>,
  services: Services,
  providedServerOptions?: Partial<{
    handshakeOptions?: ServerHandshakeOptions;
    extendedContext?: ServiceContext;
    /**
     * Maximum number of cancelled streams to keep track of to avoid
     * cascading stream errors.
     */
    maxCancelledStreamTombstonesPerSession?: number;
  }>,
): Server<Services> {
  return new RiverServer(
    transport,
    services,
    providedServerOptions?.handshakeOptions,
    providedServerOptions?.extendedContext,
    providedServerOptions?.maxCancelledStreamTombstonesPerSession,
  );
}
