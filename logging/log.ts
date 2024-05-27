import { ValueError } from '@sinclair/typebox/value';
import { OpaqueTransportMessage } from '../transport';

const LoggingLevels = {
  debug: -1,
  info: 0,
  warn: 1,
  error: 2,
} as const;
type LoggingLevel = keyof typeof LoggingLevels;

export type LogFn = (
  msg: string,
  ctx?: MessageMetadata,
  level?: LoggingLevel,
) => void;
export type Logger = {
  [key in LoggingLevel]: (msg: string, metadata?: MessageMetadata) => void;
};

export type Tags = 'invariant-violation';

function cleanMessage<T extends Partial<OpaqueTransportMessage>>(
  msg: T,
): Omit<T, 'payload' | 'tracing'> {
  const { payload, tracing, ...rest } = msg;
  return rest;
}

export type MessageMetadata = Partial<{
  protocolVersion: string;
  clientId: string;
  connectedTo: string;
  sessionId: string;
  connId: string;
  transportMessage: Omit<
    Partial<OpaqueTransportMessage>,
    'payload' | 'tracing'
  >;
  validationErrors: Array<ValueError>;
  tags: Array<Tags>;
}>;

class BaseLogger implements Logger {
  minLevel: LoggingLevel;
  private output: LogFn;

  constructor(output: LogFn, minLevel: LoggingLevel = 'info') {
    this.minLevel = minLevel;
    this.output = output;
  }

  debug(msg: string, metadata?: MessageMetadata) {
    if (LoggingLevels[this.minLevel] <= LoggingLevels.debug) {
      this.output(msg, metadata ?? {}, 'debug');
    }
  }

  info(msg: string, metadata?: MessageMetadata) {
    if (LoggingLevels[this.minLevel] <= LoggingLevels.info) {
      this.output(msg, metadata ?? {}, 'info');
    }
  }

  warn(msg: string, metadata?: MessageMetadata) {
    if (LoggingLevels[this.minLevel] <= LoggingLevels.warn) {
      this.output(msg, metadata ?? {}, 'warn');
    }
  }

  error(msg: string, metadata?: MessageMetadata) {
    if (LoggingLevels[this.minLevel] <= LoggingLevels.error) {
      this.output(msg, metadata ?? {}, 'error');
    }
  }
}

export const stringLogger: LogFn = (msg, _ctx, level = 'info') => {
  console.log(`[river:${level}] ${msg}`);
};

const colorMap = {
  debug: '\u001b[34m',
  info: '\u001b[32m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};

export const coloredStringLogger: LogFn = (msg, _ctx, level = 'info') => {
  const color = colorMap[level];
  console.log(`[river:${color}${level}\u001b[0m] ${msg}`);
};

export const jsonLogger: LogFn = (msg, ctx, level) => {
  console.log(JSON.stringify({ msg, ctx, level }));
};

let _log: Logger | undefined = undefined;

// log proxy to clean transport payloads
export let log: Logger | undefined = undefined;
const createLogProxy = (log: Logger) =>
  new Proxy(
    {},
    {
      get(_target, prop: LoggingLevel) {
        return (msg: string, metadata?: MessageMetadata) => {
          // skip cloning object if metadata has no transportMessage
          if (!metadata?.transportMessage) {
            log[prop](msg, metadata);
            return;
          }

          // clone metadata and clean transportMessage
          log[prop](msg, {
            ...metadata,
            transportMessage: cleanMessage(metadata.transportMessage ?? {}),
          });
        };
      },
    },
  ) as Logger;

export function bindLogger(
  fn: LogFn | Logger | undefined,
  level?: LoggingLevel,
): void {
  // clear logger
  if (!fn) {
    _log = undefined;
    log = undefined;
    return;
  }

  // construct logger from fn
  if (typeof fn === 'function') {
    _log = new BaseLogger(fn, level);
    log = createLogProxy(_log);
    return;
  }

  // just assign
  _log = fn;
  log = createLogProxy(_log);
}
