import { OpaqueTransportMessage } from '../transport';
import { PartialTransportMessage } from '../transport/message';

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

export type MessageMetadata = Record<string, unknown> &
  Partial<{
    protocolVersion: string;
    clientId: string;
    connectedTo: string;
    sessionId: string;
    connId: string;
    fullTransportMessage: OpaqueTransportMessage;
    partialTransportMessage: Partial<PartialTransportMessage>;
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

export let log: Logger | undefined = undefined;

export function bindLogger(fn: undefined, level?: LoggingLevel): undefined;
export function bindLogger(fn: LogFn | Logger, level?: LoggingLevel): Logger;
export function bindLogger(
  fn: LogFn | Logger | undefined,
  level?: LoggingLevel,
): Logger | undefined {
  if (typeof fn === 'function') {
    log = new BaseLogger(fn, level);
    return log;
  }

  log = fn;
  return fn;
}
