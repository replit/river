import { OpaqueTransportMessage } from '../transport';
import { PartialTransportMessage } from '../transport/message';

const LoggingLevels = {
  debug: -1,
  info: 0,
  warn: 1,
  error: 2,
} as const;

export type MessageMetadata = Partial<{
  protocolVersion: string;
  clientId: string;
  connectedTo: string;
  sessionId: string;
  connId: string;
  fullTransportMessage: OpaqueTransportMessage;
  partialTransportMessage: Partial<PartialTransportMessage>;
}>;

interface LogMessage {
  level: keyof typeof LoggingLevels;
  message: string;
  metadata?: MessageMetadata;
}

type LoggingLevel = keyof typeof LoggingLevels;

export type LogFn = (msg: LogMessage) => void;
export class Logger {
  minLevel: LoggingLevel;
  private output: LogFn;

  constructor(output: LogFn, minLevel: LoggingLevel = 'info') {
    this.minLevel = minLevel;
    this.output = output;
  }

  bindOutput(output: (msg: LogMessage) => void) {
    this.output = output;
  }

  debug(msg: string, metadata?: MessageMetadata) {
    if (LoggingLevels[this.minLevel] > LoggingLevels.debug) return;
    this.output({ level: 'debug', message: msg, metadata });
  }

  info(msg: string, metadata?: MessageMetadata) {
    if (LoggingLevels[this.minLevel] > LoggingLevels.info) return;
    this.output({ level: 'info', message: msg, metadata });
  }

  warn(msg: string, metadata?: MessageMetadata) {
    if (LoggingLevels[this.minLevel] > LoggingLevels.warn) return;
    this.output({ level: 'warn', message: msg, metadata });
  }

  error(msg: string, metadata?: MessageMetadata) {
    if (LoggingLevels[this.minLevel] > LoggingLevels.error) return;
    this.output({ level: 'error', message: msg, metadata });
  }
}

export const stringLogger: LogFn = (msg) => {
  return `[${msg.level}] ${msg.message}`;
};

const colorMap = {
  debug: '\u001b[34m',
  info: '\u001b[32m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};

export const coloredStringLogger: LogFn = (msg) => {
  const color = colorMap[msg.level];
  return `${color}${msg.level}\u001b[0m ${msg.message}`;
};

export const jsonLogger: LogFn = JSON.stringify;

/**
 * The global River logger instance.
 */
export let log: Logger | undefined = undefined;
export function bindLogger(fn: LogFn, level?: LoggingLevel) {
  log = new Logger(fn, level);
  return log;
}
