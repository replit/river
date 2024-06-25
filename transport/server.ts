import { SpanStatusCode } from '@opentelemetry/api';
import { ParsedMetadata } from '../router/context';
import { ServerHandshakeOptions } from '../router/handshake';
import {
  ControlMessageHandshakeRequestSchema,
  PROTOCOL_VERSION,
  SESSION_STATE_MISMATCH,
  TransportClientId,
  handshakeResponseMessage,
} from './message';
import {
  ProvidedServerTransportOptions,
  ServerTransportOptions,
  defaultServerTransportOptions,
} from './options';
import { Connection, Session } from './session';
import { Transport } from './transport';
import { coerceErrorString } from '../util/stringify';
import { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { ProtocolError } from './events';

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

    let session: Session<ConnType> | undefined = undefined;
    const client = () => session?.to ?? 'unknown';

    // kill the conn after the grace period if we haven't received a handshake
    const handshakeTimeout = setTimeout(() => {
      if (!session) {
        this.log?.warn(
          `connection to ${client()} timed out waiting for handshake, closing`,
          {
            ...conn.loggingMetadata,
            clientId: this.clientId,
            connectedTo: client(),
          },
        );
        conn.telemetry?.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'handshake timeout',
        });
        conn.close();
      }
    }, this.options.sessionDisconnectGraceMs);

    const buffer: Array<Uint8Array> = [];
    let receivedHandshakeMessage = false;

    const handshakeHandler = (data: Uint8Array) => {
      // if we've already received, just buffer the data
      if (receivedHandshakeMessage) {
        buffer.push(data);
        return;
      }

      receivedHandshakeMessage = true;
      clearTimeout(handshakeTimeout);

      void this.receiveHandshakeRequestMessage(data, conn).then(
        (maybeSession) => {
          if (!maybeSession) {
            conn.close();
            return;
          }

          session = maybeSession;

          // when we are done handshake sequence,
          // remove handshake listener and use the normal message listener
          const dataHandler = (data: Uint8Array) => {
            const parsed = this.parseMsg(data, conn);
            if (!parsed) {
              conn.close();
              return;
            }

            this.handleMsg(parsed, conn);
          };

          // process any data we missed
          for (const data of buffer) {
            dataHandler(data);
          }

          conn.removeDataListener(handshakeHandler);
          conn.addDataListener(dataHandler);
          buffer.length = 0;
        },
      );
    };

    conn.addDataListener(handshakeHandler);
    conn.addCloseListener(() => {
      if (!session) return;
      this.log?.info(`connection to ${client()} disconnected`, {
        ...conn.loggingMetadata,
        clientId: this.clientId,
      });
      this.onDisconnect(conn, session);
    });

    conn.addErrorListener((err) => {
      conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'connection error',
      });
      if (!session) return;
      this.log?.warn(
        `connection to ${client()} got an error: ${coerceErrorString(err)}`,
        { ...conn.loggingMetadata, clientId: this.clientId },
      );
    });
  }

  private async validateHandshakeMetadata(
    conn: ConnType,
    session: Session<ConnType> | undefined,
    rawMetadata: Static<
      typeof ControlMessageHandshakeRequestSchema
    >['metadata'],
    from: TransportClientId,
  ): Promise<ParsedMetadata | false> {
    let parsedMetadata: ParsedMetadata = {};
    if (this.handshakeExtensions) {
      // check that the metadata that was sent is the correct shape
      if (!Value.Check(this.handshakeExtensions.schema, rawMetadata)) {
        conn.telemetry?.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'malformed handshake meta',
        });
        const reason = 'received malformed handshake metadata';
        const responseMsg = handshakeResponseMessage({
          from: this.clientId,
          to: from,
          status: {
            ok: false,
            reason,
          },
        });
        conn.send(this.codec.toBuffer(responseMsg));
        this.log?.warn(`received malformed handshake metadata from ${from}`, {
          ...conn.loggingMetadata,
          clientId: this.clientId,
          validationErrors: [
            ...Value.Errors(this.handshakeExtensions.schema, rawMetadata),
          ],
        });
        this.protocolError(ProtocolError.HandshakeFailed, reason);
        return false;
      }

      const previousParsedMetadata = session
        ? this.sessionHandshakeMetadata.get(session)
        : undefined;

      parsedMetadata = await this.handshakeExtensions.validate(
        rawMetadata,
        previousParsedMetadata,
      );

      // handler rejected the connection
      if (parsedMetadata === false) {
        const reason = 'rejected by handshake handler';
        conn.telemetry?.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: reason,
        });
        const responseMsg = handshakeResponseMessage({
          from: this.clientId,
          to: from,
          status: {
            ok: false,
            reason,
          },
        });
        conn.send(this.codec.toBuffer(responseMsg));
        this.log?.warn(`rejected handshake from ${from}`, {
          ...conn.loggingMetadata,
          clientId: this.clientId,
        });
        this.protocolError(ProtocolError.HandshakeFailed, reason);
        return false;
      }
    }

    return parsedMetadata;
  }

  async receiveHandshakeRequestMessage(
    data: Uint8Array,
    conn: ConnType,
  ): Promise<Session<ConnType> | false> {
    const parsed = this.parseMsg(data, conn);
    if (!parsed) {
      conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'non-transport message',
      });
      this.protocolError(
        ProtocolError.HandshakeFailed,
        'received non-transport message',
      );
      return false;
    }

    if (!Value.Check(ControlMessageHandshakeRequestSchema, parsed.payload)) {
      conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'invalid handshake request',
      });
      const reason = 'received invalid handshake msg';
      const responseMsg = handshakeResponseMessage({
        from: this.clientId,
        to: parsed.from,
        status: {
          ok: false,
          reason,
        },
      });
      conn.send(this.codec.toBuffer(responseMsg));
      this.log?.warn(reason, {
        ...conn.loggingMetadata,
        clientId: this.clientId,
        // safe to this.log metadata here as we remove the payload
        // before passing it to user-land
        transportMessage: parsed,
        validationErrors: [
          ...Value.Errors(ControlMessageHandshakeRequestSchema, parsed.payload),
        ],
      });
      this.protocolError(
        ProtocolError.HandshakeFailed,
        'invalid handshake request',
      );
      return false;
    }

    // double check protocol version here
    const gotVersion = parsed.payload.protocolVersion;
    if (gotVersion !== PROTOCOL_VERSION) {
      conn.telemetry?.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'incorrect protocol version',
      });

      const reason = `incorrect version (got: ${gotVersion} wanted ${PROTOCOL_VERSION})`;
      const responseMsg = handshakeResponseMessage({
        from: this.clientId,
        to: parsed.from,
        status: {
          ok: false,
          reason,
        },
      });
      conn.send(this.codec.toBuffer(responseMsg));
      this.log?.warn(
        `received handshake msg with incompatible protocol version (got: ${gotVersion}, expected: ${PROTOCOL_VERSION})`,
        { ...conn.loggingMetadata, clientId: this.clientId },
      );
      this.protocolError(ProtocolError.HandshakeFailed, reason);
      return false;
    }

    const oldSession = this.sessions.get(parsed.from);
    const parsedMetadata = await this.validateHandshakeMetadata(
      conn,
      oldSession,
      parsed.payload.metadata,
      parsed.from,
    );

    if (parsedMetadata === false) {
      return false;
    }

    let session: Session<ConnType>;
    let isTransparentReconnect: boolean;
    if (parsed.payload.expectedSessionState.reconnect) {
      // this has to be an existing session. if it doesn't match what we expect, reject the
      // handshake
      const existingSession = this.getExistingSession({
        to: parsed.from,
        sessionId: parsed.payload.sessionId,
        nextExpectedSeq: parsed.payload.expectedSessionState.nextExpectedSeq,
      });
      if (existingSession === false) {
        conn.telemetry?.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: SESSION_STATE_MISMATCH,
        });

        const reason = SESSION_STATE_MISMATCH;
        const responseMsg = handshakeResponseMessage({
          from: this.clientId,
          to: parsed.from,
          status: {
            ok: false,
            reason,
          },
        });
        conn.send(this.codec.toBuffer(responseMsg));
        this.log?.warn(
          `'received handshake msg with incompatible existing session state: ${parsed.payload.sessionId}`,
          { ...conn.loggingMetadata, clientId: this.clientId },
        );
        this.protocolError(ProtocolError.HandshakeFailed, reason);
        return false;
      }
      session = existingSession;
      isTransparentReconnect = false;
    } else {
      // this has to be a new session. if one already exists, it will be replaced silently
      const createdSession = this.createNewSession({
        to: parsed.from,
        conn,
        sessionId: parsed.payload.sessionId,
        propagationCtx: parsed.tracing,
      });
      session = createdSession;
      isTransparentReconnect = false;
    }

    this.sessionHandshakeMetadata.set(session, parsedMetadata);

    this.log?.debug(
      `handshake from ${parsed.from} ok, responding with handshake success`,
      conn.loggingMetadata,
    );
    const responseMsg = handshakeResponseMessage({
      from: this.clientId,
      to: parsed.from,
      status: {
        ok: true,
        sessionId: session.id,
      },
    });
    conn.send(this.codec.toBuffer(responseMsg));
    this.onConnect(conn, session, isTransparentReconnect);

    return session;
  }
}
