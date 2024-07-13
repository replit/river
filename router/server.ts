import { Static } from '@sinclair/typebox';
import {
  PayloadType,
  ProcedureErrorSchemaType,
  InputReaderErrorSchema,
  OutputReaderErrorSchema,
  UNCAUGHT_ERROR_CODE,
  UNEXPECTED_DISCONNECT_CODE,
  AnyProcedure,
  ABORT_CODE,
  INVALID_REQUEST_CODE,
  INTERNAL_RIVER_ERROR_CODE,
} from './procedures';
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
  isStreamCloseRequest,
  isStreamAbort,
  requestCloseStreamMessage,
  closeStreamMessage,
  abortMessage,
} from '../transport/message';
import {
  ServiceContext,
  ProcedureHandlerContext,
  ParsedMetadata,
} from './context';
import { Logger, MessageMetadata } from '../logging/log';
import { Value } from '@sinclair/typebox/value';
import { Err, Result, Ok, ErrResultSchema, ErrResult } from './result';
import { EventMap } from '../transport/events';
import { coerceErrorString } from '../util/stringify';
import { Span, SpanStatusCode } from '@opentelemetry/api';
import { PropagationContext, createHandlerSpan } from '../tracing';
import { ServerHandshakeOptions } from './handshake';
import { Connection } from '../transport/connection';
import { ServerTransport } from '../transport/server';
import { ReadStreamImpl, WriteStreamImpl } from './streams';

type StreamId = string;

/**
 * A result schema for errors that can be passed to input's readstream
 */
const InputErrResultSchema = ErrResultSchema(InputReaderErrorSchema);

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
  openStreams: Set<StreamId>;
}

type InputHandlerReturn = Promise<(() => void) | void>;

interface NewProcStreamInput {
  procedure: AnyProcedure;
  procedureName: string;
  service: AnyService;
  serviceName: string;
  sessionMetadata: ParsedMetadata;
  loggingMetadata: MessageMetadata;
  streamId: string;
  controlFlags: number;
  tracingCtx?: PropagationContext;
  initPayload: Static<PayloadType>;
  from: string;
  sessionId: string;
  protocolVersion: string;
  passInitAsInputForBackwardsCompat: boolean;
}

class RiverServer<Services extends AnyServiceSchemaMap>
  implements Server<Services>
{
  private transport: ServerTransport<Connection>;
  private contextMap: Map<AnyService, ServiceContext & { state: object }>;
  private log?: Logger;
  /**
   * We create a tombstones for streams aborted by the server
   * so that we don't hit errors when the client has inflight
   * requests it sent before it saw the abort.
   * We track aborted streams for every session separately, so
   * that bad clients don't affect good clients.
   */
  private serverAbortedStreams: Map<string, LRUSet>;
  private maxAbortedStreamTombstonesPerSession: number;

  public openStreams: Set<string>;
  public services: InstantiatedServiceSchemaMap<Services>;

  constructor(
    transport: ServerTransport<Connection>,
    services: Services,
    handshakeOptions?: ServerHandshakeOptions,
    extendedContext?: Omit<ServiceContext, 'state'>,
    maxAbortedStreamTombstonesPerSession = 200,
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
    this.openStreams = new Set();
    this.serverAbortedStreams = new Map();
    this.maxAbortedStreamTombstonesPerSession =
      maxAbortedStreamTombstonesPerSession;
    this.log = transport.log;

    const handleMessage = (msg: EventMap['message']) => {
      if (msg.to !== this.transport.clientId) {
        this.log?.info(
          `got msg with destination that isn't this server, ignoring`,
          {
            clientId: this.transport.clientId,
            transportMessage: msg,
          },
        );
        return;
      }

      if (this.openStreams.has(msg.streamId)) {
        // has its own message handler
        return;
      }

      if (this.serverAbortedStreams.get(msg.from)?.has(msg.streamId)) {
        return;
      }

      const validated = this.validateNewProcStream(msg);

      if (!validated) {
        return;
      }

      this.createNewProcStream(validated);
    };
    this.transport.addEventListener('message', handleMessage);

    const handleSessionStatus = (evt: EventMap['sessionStatus']) => {
      if (evt.status !== 'disconnect') return;

      const disconnectedClientId = evt.session.to;
      this.log?.info(
        `got session disconnect from ${disconnectedClientId}, cleaning up streams`,
        evt.session.loggingMetadata,
      );

      this.serverAbortedStreams.delete(disconnectedClientId);
    };
    this.transport.addEventListener('sessionStatus', handleSessionStatus);

    this.transport.addEventListener('transportStatus', (evt) => {
      if (evt.status !== 'closed') return;

      this.transport.removeEventListener('message', handleMessage);
      this.transport.removeEventListener('sessionStatus', handleSessionStatus);
    });
  }

  private createNewProcStream({
    procedure,
    procedureName,
    service,
    serviceName,
    sessionMetadata,
    loggingMetadata,
    streamId,
    controlFlags,
    initPayload,
    from,
    sessionId,
    tracingCtx,
    protocolVersion,
    passInitAsInputForBackwardsCompat,
  }: NewProcStreamInput) {
    this.openStreams.add(streamId);

    let cleanClose = true;

    const onServerAbort = (errResult: Static<typeof InputErrResultSchema>) => {
      if (inputReader.isClosed() && outputWriter.isClosed()) {
        // Everything already closed, no-op.
        return;
      }

      cleanClose = false;

      if (!inputReader.isClosed()) {
        inputReader.pushValue(errResult);
        inputReader.triggerClose();
      }

      outputWriter.close();
      this.abortStream(from, streamId, errResult);
    };

    const onHandlerAbort = () => {
      onServerAbort(
        Err({
          code: ABORT_CODE,
          message: 'Aborted by server procedure handler',
        }),
      );
    };
    const handlerAbortController = new AbortController();
    handlerAbortController.signal.addEventListener('abort', onHandlerAbort);

    const clientAbortController = new AbortController();

    const onSessionStatus = (evt: EventMap['sessionStatus']) => {
      if (evt.status !== 'disconnect') {
        return;
      }

      if (evt.session.to !== from) {
        return;
      }

      cleanClose = false;

      const errPayload = {
        code: UNEXPECTED_DISCONNECT_CODE,
        message: `client unexpectedly disconnected`,
      } as const;
      if (!inputReader.isClosed()) {
        inputReader.pushValue(Err(errPayload));
        inputReader.triggerClose();
      }

      clientAbortController.abort(errPayload);

      outputWriter.close();
    };
    this.transport.addEventListener('sessionStatus', onSessionStatus);

    const onMessage = (msg: OpaqueTransportMessage) => {
      if (streamId !== msg.streamId) {
        return;
      }

      if (msg.from !== from) {
        this.log?.error('Got stream message from unexpected client', {
          ...loggingMetadata,
          clientId: this.transport.clientId,
          transportMessage: msg,
          tags: ['invariant-violation'],
        });

        return;
      }

      if (isStreamCloseRequest(msg.controlFlags)) {
        outputWriter.triggerCloseRequest();
      }

      if (isStreamAbortBackwardsCompat(msg.controlFlags, protocolVersion)) {
        let abortResult: Static<typeof InputErrResultSchema>;
        if (Value.Check(InputErrResultSchema, msg.payload)) {
          abortResult = msg.payload;
        } else {
          abortResult = Err({
            code: ABORT_CODE,
            message: 'Stream aborted, client sent invalid payload',
          });
          this.log?.warn('Got stream abort without a valid protocol error', {
            ...loggingMetadata,
            clientId: this.transport.clientId,
            transportMessage: msg,
            validationErrors: [
              ...Value.Errors(InputErrResultSchema, msg.payload),
            ],
            tags: ['invalid-request'],
          });
        }

        if (!inputReader.isClosed()) {
          inputReader.pushValue(abortResult);
          inputReader.triggerClose();
        }

        outputWriter.close();

        clientAbortController.abort(abortResult.payload);

        return;
      }

      if (inputReader.isClosed()) {
        this.log?.warn('Received message after input stream is closed', {
          ...loggingMetadata,
          clientId: this.transport.clientId,
          transportMessage: msg,
          tags: ['invalid-request'],
        });

        onServerAbort(
          Err({
            code: INVALID_REQUEST_CODE,
            message: 'Received message after input stream is closed',
          }),
        );

        return;
      }

      if ('input' in procedure && Value.Check(procedure.input, msg.payload)) {
        inputReader.pushValue(Ok(msg.payload));
      } else if (!Value.Check(ControlMessagePayloadSchema, msg.payload)) {
        const validationErrors = [
          ...Value.Errors(ControlMessagePayloadSchema, msg.payload),
        ];
        let errMessage = 'Expected control payload for procedure with no input';
        if ('input' in procedure) {
          errMessage =
            'Expected either control or input payload, validation failed for both';
          validationErrors.push(...Value.Errors(procedure.input, msg.payload));
        }

        this.log?.warn(errMessage, {
          ...loggingMetadata,
          clientId: this.transport.clientId,
          transportMessage: msg,
          validationErrors,
          tags: ['invalid-request'],
        });

        onServerAbort(
          Err({
            code: INVALID_REQUEST_CODE,
            message: errMessage,
          }),
        );
      }

      if (isStreamCloseBackwardsCompat(msg.controlFlags, protocolVersion)) {
        inputReader.triggerClose();
      }
    };
    this.transport.addEventListener('message', onMessage);

    const onFinishedCallbacks: Array<() => void> = [];
    const cleanup = () => {
      this.transport.removeEventListener('message', onMessage);
      this.transport.removeEventListener('sessionStatus', onSessionStatus);
      handlerAbortController.signal.addEventListener('abort', onHandlerAbort);

      this.openStreams.delete(streamId);
      onFinishedCallbacks.forEach((cb) => {
        try {
          cb();
        } catch {
          // ignore user errors
        }
      });
      onFinishedCallbacks.length = 0;
    };

    const procClosesWithResponse =
      procedure.type === 'rpc' || procedure.type === 'upload';

    const inputReader = new ReadStreamImpl<
      Static<PayloadType>,
      Static<typeof InputReaderErrorSchema>
    >(() => {
      this.transport.send(from, requestCloseStreamMessage(streamId));
    });
    inputReader.onClose(() => {
      // TODO remove once clients migrate to v2
      if (protocolVersion === 'v1.1') {
        // in v1.1 a close in either direction should close everything
        // for upload/rpc it will handle the close after it responds
        if (!procClosesWithResponse && !outputWriter.isClosed()) {
          outputWriter.close();
        }
      }

      if (outputWriter.isClosed()) {
        cleanup();
      }
    });

    if (passInitAsInputForBackwardsCompat) {
      inputReader.pushValue(Ok(initPayload));
    }

    const outputWriter = new WriteStreamImpl<
      Result<Static<PayloadType>, Static<ProcedureErrorSchemaType>>
    >((response) => {
      this.transport.send(from, {
        streamId,
        controlFlags: procClosesWithResponse
          ? getStreamCloseBackwardsCompat(protocolVersion)
          : 0,
        payload: response,
      });
    });
    outputWriter.onClose(() => {
      if (!procClosesWithResponse && cleanClose) {
        // we ended, send a close bit back to the client
        // also, if the client has disconnected, we don't need to send a close

        const message = closeStreamMessage(streamId);
        // TODO remove once clients migrate to v2
        message.controlFlags = getStreamCloseBackwardsCompat(protocolVersion);

        this.transport.send(from, closeStreamMessage(streamId));
      }

      // TODO remove once clients migrate to v2
      if (protocolVersion === 'v1.1') {
        // in v1.1 a close in either direction should close everything
        if (!inputReader.isClosed()) {
          inputReader.triggerClose();
        }
      }

      if (inputReader.isClosed()) {
        cleanup();
      }
    });

    const onHandlerError = (err: unknown, span: Span) => {
      const errorMsg = coerceErrorString(err);

      span.recordException(err instanceof Error ? err : new Error(errorMsg));
      span.setStatus({ code: SpanStatusCode.ERROR });

      onServerAbort(
        Err({
          code: UNCAUGHT_ERROR_CODE,
          message: errorMsg,
        }),
      );
    };

    if (isStreamCloseBackwardsCompat(controlFlags, protocolVersion)) {
      inputReader.triggerClose();
    } else if (procedure.type === 'rpc' || procedure.type === 'subscription') {
      // Though things can work just fine if they eventually follow up with a stream
      // control message with a close bit set, it's an unusual client implementation!
      this.log?.warn(`${procedure.type} sent an init without a stream close`, {
        ...loggingMetadata,
        clientId: this.transport.clientId,
      });
    }

    const serviceContextWithTransportInfo: ProcedureHandlerContext<object> = {
      ...this.getContext(service, serviceName),
      from,
      sessionId,
      metadata: sessionMetadata,
      abortController: handlerAbortController,
      clientAbortSignal: clientAbortController.signal,
      onRequestFinished: (cb) => {
        if (inputReader.isClosed() && outputWriter.isClosed()) {
          // Everything already closed, call cleanup immediately.
          try {
            cb();
          } catch {
            // ignore user errors
          }

          return;
        }

        onFinishedCallbacks.push(cb);
      },
    };

    switch (procedure.type) {
      case 'rpc':
        void createHandlerSpan(
          procedure.type,
          serviceName,
          procedureName,
          streamId,
          tracingCtx,
          async (span): InputHandlerReturn => {
            try {
              // TODO handle never resolving after cleanup/full close
              // which would lead to us holding on to the closure forever
              const outputMessage = await procedure.handler(
                serviceContextWithTransportInfo,
                initPayload,
              );

              if (outputWriter.isClosed()) {
                // A disconnect happened
                return;
              }

              outputWriter.write(outputMessage);
              outputWriter.close();
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
          async (span): InputHandlerReturn => {
            try {
              // TODO handle never resolving after cleanup/full close
              // which would lead to us holding on to the closure forever
              await procedure.handler(
                serviceContextWithTransportInfo,
                initPayload,
                inputReader,
                outputWriter,
              );
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
          async (span): InputHandlerReturn => {
            try {
              // TODO handle never resolving after cleanup/full close
              // which would lead to us holding on to the closure forever
              await procedure.handler(
                serviceContextWithTransportInfo,
                passInitAsInputForBackwardsCompat ? null : initPayload,
                outputWriter,
              );
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
          async (span): InputHandlerReturn => {
            try {
              // TODO handle never resolving after cleanup/full close
              // which would lead to us holding on to the closure forever
              const outputMessage = await procedure.handler(
                serviceContextWithTransportInfo,
                passInitAsInputForBackwardsCompat ? null : initPayload,
                inputReader,
              );

              if (outputWriter.isClosed()) {
                // A disconnect happened
                return;
              }
              outputWriter.write(outputMessage);
              outputWriter.close();
            } catch (err) {
              onHandlerError(err, span);
            } finally {
              span.end();
            }
          },
        );

        break;
      default:
        this.log?.error(
          `got request for invalid procedure type ${
            (procedure as AnyProcedure).type
          } at ${serviceName}.${procedureName}`,
          {
            ...loggingMetadata,
            tags: ['invariant-violation'],
          },
        );

        return;
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
  ): null | NewProcStreamInput {
    const session = this.transport.sessions.get(initMessage.from);
    if (!session) {
      const errMessage = `couldn't find a session for ${initMessage.from}`;
      this.log?.error(`couldn't find session for ${initMessage.from}`, {
        clientId: this.transport.clientId,
        transportMessage: initMessage,
        tags: ['invariant-violation'],
      });

      this.abortStream(
        initMessage.from,
        initMessage.streamId,
        Err({
          code: INTERNAL_RIVER_ERROR_CODE,
          message: errMessage,
        }),
      );

      return null;
    }

    const sessionMetadata = this.transport.sessionHandshakeMetadata.get(
      session.to,
    );
    if (!sessionMetadata) {
      const errMessage = `session doesn't have handshake metadata`;
      this.log?.error(errMessage, {
        ...session.loggingMetadata,
        tags: ['invariant-violation'],
      });

      this.abortStream(
        initMessage.from,
        initMessage.streamId,
        Err({
          code: INTERNAL_RIVER_ERROR_CODE,
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

      this.abortStream(
        initMessage.from,
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
        clientId: this.transport.clientId,
        transportMessage: initMessage,
        tags: ['invalid-request'],
      });

      this.abortStream(
        initMessage.from,
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
        clientId: this.transport.clientId,
        transportMessage: initMessage,
        tags: ['invalid-request'],
      });

      this.abortStream(
        initMessage.from,
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

      this.abortStream(
        initMessage.from,
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
        clientId: this.transport.clientId,
        transportMessage: initMessage,
        tags: ['invalid-request'],
      });

      this.abortStream(
        initMessage.from,
        initMessage.streamId,
        Err({
          code: INVALID_REQUEST_CODE,
          message: errMessage,
        }),
      );

      return null;
    }

    const procedure = service.procedures[initMessage.procedureName];

    let passInitAsInputForBackwardsCompat = false;
    if (
      session.protocolVersion === 'v1.1' &&
      (procedure.type === 'upload' || procedure.type === 'stream') &&
      Value.Check(procedure.input, initMessage.payload) &&
      Value.Check(procedure.init, {})
    ) {
      // TODO remove once clients migrate to v2
      // In v1.1 sometimes the first message is not `init`, but instead it's the `input`
      // this backwards compatibility path requires procedures to define their `init` as
      // an empty-object-compatible-schema (i.e. either actually empty or optional values)
      // The reason we don't check if `init` is satisified here is because false positives
      // are easy to hit, we'll err on the side of caution and treat it as an input, servers
      // that expect v1.1 clients should handle this case themselves.
      passInitAsInputForBackwardsCompat = true;
    } else if (!Value.Check(procedure.init, initMessage.payload)) {
      const errMessage = `procedure init failed validation`;
      this.log?.warn(errMessage, {
        ...session.loggingMetadata,
        clientId: this.transport.clientId,
        transportMessage: initMessage,
        tags: ['invalid-request'],
      });

      this.abortStream(
        initMessage.from,
        initMessage.streamId,
        Err({
          code: INVALID_REQUEST_CODE,
          message: errMessage,
        }),
      );

      return null;
    }

    return {
      sessionMetadata,
      procedure,
      procedureName: initMessage.procedureName,
      service,
      serviceName: initMessage.serviceName,
      loggingMetadata: {
        ...session.loggingMetadata,
        transportMessage: initMessage,
      },
      streamId: initMessage.streamId,
      controlFlags: initMessage.controlFlags,
      tracingCtx: initMessage.tracing,
      initPayload: initMessage.payload,
      from: initMessage.from,
      sessionId: session.id,
      protocolVersion: session.protocolVersion,
      passInitAsInputForBackwardsCompat,
    };
  }

  abortStream(
    to: string,
    streamId: string,
    payload: ErrResult<Static<typeof OutputReaderErrorSchema>>,
  ) {
    let abortedForSession = this.serverAbortedStreams.get(to);

    if (!abortedForSession) {
      abortedForSession = new LRUSet(this.maxAbortedStreamTombstonesPerSession);

      this.serverAbortedStreams.set(to, abortedForSession);
    }

    abortedForSession.add(streamId);

    this.transport.send(
      to,
      // TODO remove once clients migrate to v2
      this.transport.sessions.get(to)?.protocolVersion === 'v1.1'
        ? closeStreamMessage(streamId)
        : abortMessage(streamId, payload),
    );
  }
}

class LRUSet {
  private items: Set<StreamId>;
  private maxItems: number;

  constructor(maxItems: number) {
    this.items = new Set();
    this.maxItems = maxItems;
  }

  add(item: string) {
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

  has(item: string) {
    return this.items.has(item);
  }
}

// TODO remove once clients migrate to v2
function isStreamAbortBackwardsCompat(
  controlFlags: ControlFlags,
  protocolVersion: string,
) {
  if (protocolVersion === 'v1.1') {
    // in 1.1 we don't have abort
    return false;
  }

  return isStreamAbort(controlFlags);
}

// TODO remove once clients migrate to v2
function isStreamCloseBackwardsCompat(
  controlFlags: ControlFlags,
  protocolVersion: string,
) {
  if (protocolVersion === 'v1.1') {
    // in v1.1 the bits for close is what we use for abort now
    return isStreamAbort(controlFlags);
  }

  return isStreamClose(controlFlags);
}

// TODO remove once clients migrate to v2
function getStreamCloseBackwardsCompat(protocolVersion: string) {
  if (protocolVersion === 'v1.1') {
    // in v1.1 the bits for close is what we use for abort now
    return ControlFlags.StreamAbortBit;
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
    extendedContext?: Omit<ServiceContext, 'state'>;
    /**
     * Maximum number of aborted streams to keep track of to avoid
     * cascading stream errors.
     */
    maxAbortedStreamTombstonesPerSession?: number;
  }>,
): Server<Services> {
  return new RiverServer(
    transport,
    services,
    providedServerOptions?.handshakeOptions,
    providedServerOptions?.extendedContext,
    providedServerOptions?.maxAbortedStreamTombstonesPerSession,
  );
}
