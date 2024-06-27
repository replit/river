import { SpanStatusCode } from '@opentelemetry/api';
import { ParsedMetadata } from '../router/context';
import { ServerHandshakeOptions } from '../router/handshake';
import {
  ControlMessageHandshakeRequestSchema,
  PROTOCOL_VERSION,
  PartialTransportMessage,
  SESSION_STATE_MISMATCH,
  TransportClientId,
  handshakeResponseMessage,
} from './message';
import {
  ProvidedServerTransportOptions,
  ServerTransportOptions,
  defaultServerTransportOptions,
} from './options';
import { Transport } from './transport';
import { coerceErrorString } from '../util/stringify';
import { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ProtocolError } from './events';
import { Connection } from './connection';
import {
  Session,
  SessionNoConnection,
  SessionPendingIdentification,
  SessionStateMachine,
} from './sessionStateMachine';

export abstract class ServerTransport<
  ConnType extends Connection,
> extends Transport<ConnType> {
  /**
   * The options for this transport.
   */
  protected options: ServerTransportOptions;

  /**
   * Optional handshake options for the server.
   */
  handshakeExtensions?: ServerHandshakeOptions;

  /**
   * A map of session handshake data for each session.
   */
  sessionHandshakeMetadata: WeakMap<Session<ConnType>, ParsedMetadata>;
  pendingSessions = new Set<SessionPendingIdentification<ConnType>>();

  constructor(
    clientId: TransportClientId,
    providedOptions?: ProvidedServerTransportOptions,
  ) {
    super(clientId, providedOptions);
    this.options = {
      ...defaultServerTransportOptions,
      ...providedOptions,
    };
    this.sessionHandshakeMetadata = new WeakMap();
    this.log?.info(`initiated server transport`, {
      clientId: this.clientId,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  extendHandshake(options: ServerHandshakeOptions) {
    this.handshakeExtensions = options;
  }

  protected handleConnection(conn: ConnType) {
    if (this.getStatus() !== 'open') return;

    this.log?.info(`new incoming connection`, {
      ...conn.loggingMetadata,
      clientId: this.clientId,
    });

    const pendingSession =
      SessionStateMachine.entrypoints.PendingIdentification(
        this.clientId,
        conn,
        {
          onConnectionClosed: () => {},
          onConnectionErrored: (err) => {},
          onHandshakeTimeout: () => {},
          onHandshake: (msg) => {},
        },
        this.options,
      );

    this.pendingSessions.add(pendingSession);
  }
}
