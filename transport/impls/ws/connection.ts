import { Connection, type ConnectionExtras } from '../../connection';
import { WsLike } from './wslike';

const WS_HEALTHY_CLOSE_CODE = 1000;

// Request headers that carry credentials (https://fetch.spec.whatwg.org/#credentials).
const CREDENTIAL_HEADERS = new Set([
  'cookie',
  'authorization',
  'proxy-authorization',
]);

// copy of the extras for log metadata with credential header values redacted
function redactCredentialHeaders(extras: ConnectionExtras): ConnectionExtras {
  const headers = extras.headers;
  const proto: unknown =
    typeof headers === 'object' && headers !== null
      ? Object.getPrototypeOf(headers)
      : undefined;
  if (proto !== Object.prototype && proto !== null) {
    return extras;
  }

  const redactedHeaders: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers as object)) {
    redactedHeaders[key] = CREDENTIAL_HEADERS.has(key.toLowerCase())
      ? '[redacted]'
      : value;
  }

  return { ...extras, headers: redactedHeaders };
}

export class WebSocketCloseError extends Error {
  code: number;
  reason: string;

  constructor(code: number, reason: string) {
    super(`websocket closed with code and reason: ${code} - ${reason}`);
    this.code = code;
    this.reason = reason;
  }
}

export class WebSocketConnection extends Connection {
  ws: WsLike;

  // logged instead of `extras`, which may carry credentials
  private readonly loggingExtras?: ConnectionExtras;

  get loggingMetadata() {
    const metadata = super.loggingMetadata;
    if (this.loggingExtras) {
      metadata.extras = this.loggingExtras;
    }

    return metadata;
  }

  constructor(ws: WsLike, extras?: ConnectionExtras) {
    super(extras);
    this.loggingExtras = extras && redactCredentialHeaders(extras);
    this.ws = ws;
    this.ws.binaryType = 'arraybuffer';

    // Websockets are kinda shitty, they emit error events with no
    // information other than it errored, so we have to do some extra
    // work to figure out what happened.
    let didError = false;
    this.ws.onerror = () => {
      didError = true;
    };

    this.ws.onclose = ({ code, reason }) => {
      if (didError) {
        const err = new WebSocketCloseError(code, reason);
        this.onError(err);
      }

      this.onClose();
    };

    this.ws.onmessage = (msg) => {
      this.onData(msg.data as Uint8Array);
    };
  }

  send(payload: Uint8Array) {
    try {
      this.ws.send(payload);

      return true;
    } catch {
      return false;
    }
  }

  close() {
    // we close with 1000 normal even if its not really healthy at the river level
    // if we don't specify this, it defaults to 1005 which
    // some proxies/loggers detect as an error
    this.ws.close(WS_HEALTHY_CLOSE_CODE);
  }
}
