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
  ctx: MessageMetadata,
  level: LoggingLevel,
) => void;
export type Logger = {
  [key in LoggingLevel]: LogFn;
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

class BaseLogger {
  minLevel: LoggingLevel;
  private output: LogFn;

  constructor(output: LogFn, minLevel: LoggingLevel = 'info') {
    this.minLevel = minLevel;
    this.output = output;
  }

  debug(msg: string, metadata?: MessageMetadata) {
    if (LoggingLevels[this.minLevel] > LoggingLevels.debug) return;
    this.output(msg, metadata ?? {}, 'debug');
  }

  info(msg: string, metadata?: MessageMetadata) {
    if (LoggingLevels[this.minLevel] > LoggingLevels.info) return;
    this.output(msg, metadata ?? {}, 'info');
  }

  warn(msg: string, metadata?: MessageMetadata) {
    if (LoggingLevels[this.minLevel] > LoggingLevels.warn) return;
    this.output(msg, metadata ?? {}, 'warn');
  }

  error(msg: string, metadata?: MessageMetadata) {
    if (LoggingLevels[this.minLevel] > LoggingLevels.error) return;
    this.output(msg, metadata ?? {}, 'error');
  }
}

export const stringLogger: LogFn = (msg, _ctx, level) => {
  console.log(`[river:${level}] ${msg}`);
};

const colorMap = {
  debug: '\u001b[34m',
  info: '\u001b[32m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};

export const coloredStringLogger: LogFn = (msg, _ctx, level) => {
  const color = colorMap[level];
  console.log(`[river:${color}${level}\u001b[0m] ${msg}`);
};

export const jsonLogger: LogFn = (msg, ctx, level) => {
  console.log(JSON.stringify({ msg, ctx, level }));
};

export let log: BaseLogger | undefined = undefined;
export function bindLogger(fn: LogFn | BaseLogger, level?: LoggingLevel) {
  if (fn instanceof BaseLogger) {
    log = fn;
    return fn;
  }

  log = new BaseLogger(fn, level);
  return log;
}
