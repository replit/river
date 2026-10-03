import { Connection } from '../../transport/connection';
import { ClientTransport } from '../../transport/client';
import { ServerTransport } from '../../transport/server';
import type {
  ProvidedClientTransportOptions,
  ProvidedServerTransportOptions,
} from '../../transport/options';
import type { TransportClientId } from '../../transport/message';

/** Bytes no codec can decode. */
const GARBAGE = new Uint8Array([0x7b]);

type Side = 'client' | 'server';

/**
 * One end of a scripted link. Like WebSocket.send on a closing socket, a send
 * after the link closed is silently discarded rather than reported as a failure.
 */
export class ScriptedConnection extends Connection {
  readonly linkId: number;
  private readonly network: ScriptedNetwork;
  private readonly side: Side;

  constructor(network: ScriptedNetwork, linkId: number, side: Side) {
    super();
    this.network = network;
    this.linkId = linkId;
    this.side = side;
  }

  send(payload: Uint8Array): boolean {
    this.network.send(this.linkId, this.side, payload);

    return true;
  }

  close(): void {
    this.network.close(this.linkId);
  }
}

export interface Link {
  id: number;
  toServer: Array<Uint8Array>;
  toClient: Array<Uint8Array>;
  closed: boolean;
  clientEv: boolean;
  serverEv: boolean;
  client: ScriptedConnection;
  server: ScriptedConnection;
}

interface PendingDial {
  resolve: (conn: ScriptedConnection) => void;
  reject: (err: Error) => void;
}

/**
 * A network where nothing happens until the test says so: dials stay pending,
 * frames sit in flight, and close events wait until delivered explicitly. This
 * lets a model trace choose every interleaving.
 */
export class ScriptedNetwork {
  readonly links = new Map<number, Link>();
  readonly dials = new Map<number, PendingDial>();
  private nextLink = 1;
  private nextDial = 1;
  acceptor: ((conn: ScriptedConnection) => void) | undefined;

  /** The most recent dial, which a Connecting client is waiting on. */
  get lastDial(): number {
    return this.nextDial - 1;
  }

  dial(): Promise<ScriptedConnection> {
    const id = this.nextDial++;

    return new Promise((resolve, reject) => {
      this.dials.set(id, { resolve, reject });
    });
  }

  /** The server accepts the connection before the client's dial resolves. */
  completeDial(dialId: number) {
    const dial = this.takeDial(dialId);
    const id = this.nextLink++;
    const link: Link = {
      id,
      toServer: [],
      toClient: [],
      closed: false,
      clientEv: false,
      serverEv: false,
      client: new ScriptedConnection(this, id, 'client'),
      server: new ScriptedConnection(this, id, 'server'),
    };
    this.links.set(id, link);
    this.acceptor?.(link.server);
    dial.resolve(link.client);
  }

  failDial(dialId: number) {
    this.takeDial(dialId).reject(new Error('dial failed'));
  }

  send(linkId: number, from: Side, payload: Uint8Array) {
    const link = this.link(linkId);
    if (link.closed) return;

    (from === 'client' ? link.toServer : link.toClient).push(payload);
  }

  close(linkId: number) {
    this.link(linkId).closed = true;
  }

  deliver(linkId: number, toServer: boolean) {
    const link = this.link(linkId);
    const frame = (toServer ? link.toServer : link.toClient).shift();
    if (!frame) throw new Error(`no frame in flight on link ${linkId}`);

    (toServer ? link.server : link.client).onData(frame);
  }

  drop(linkId: number, toServer: boolean) {
    const link = this.link(linkId);
    (toServer ? link.toServer : link.toClient).shift();
  }

  /** A close event reaches one side; frames still headed there are lost. */
  closeEvent(linkId: number, toServer: boolean) {
    const link = this.link(linkId);
    if (toServer) {
      link.serverEv = true;
      link.toServer = [];
      link.server.onClose();
    } else {
      link.clientEv = true;
      link.toClient = [];
      link.client.onClose();
    }
  }

  garbage(linkId: number, toServer: boolean) {
    const link = this.link(linkId);
    (toServer ? link.server : link.client).onData(GARBAGE);
  }

  /** The server process dies: its side of every link is gone. */
  crashServer() {
    for (const link of this.links.values()) {
      link.closed = true;
      link.serverEv = true;
      link.toServer = [];
    }
  }

  private link(id: number): Link {
    const link = this.links.get(id);
    if (!link) throw new Error(`unknown link ${id}`);

    return link;
  }

  private takeDial(id: number): PendingDial {
    const dial = this.dials.get(id);
    if (!dial) throw new Error(`unknown dial ${id}`);
    this.dials.delete(id);

    return dial;
  }
}

export class ScriptedClientTransport extends ClientTransport<ScriptedConnection> {
  private readonly network: ScriptedNetwork;

  constructor(
    clientId: TransportClientId,
    network: ScriptedNetwork,
    options?: ProvidedClientTransportOptions,
  ) {
    super(clientId, options);
    this.network = network;
  }

  protected createNewOutgoingConnection(): Promise<ScriptedConnection> {
    return this.network.dial();
  }
}

export class ScriptedServerTransport extends ServerTransport<ScriptedConnection> {
  constructor(
    clientId: TransportClientId,
    network: ScriptedNetwork,
    options?: ProvidedServerTransportOptions,
  ) {
    super(clientId, options);
    network.acceptor = (conn) => {
      this.handleConnection(conn);
    };
  }

  /** Process death: handshakes in progress vanish along with everything else. */
  crash() {
    for (const pending of Array.from(this.pendingSessions)) {
      this.deletePendingSession(pending);
    }

    this.close();
  }
}
