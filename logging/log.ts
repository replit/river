import { ValueError } from '@sinclair/typebox/value';
import { OpaqueTransportMessage } from '../transport/message';

const LoggingLevels = {
  debug: -1,
  info: 0,
  warn: 1,
  error: 2,
} as const;
export type LoggingLevel = keyof typeof LoggingLevels;

export type LogFn = (
  msg: string,
  ctx?: MessageMetadata,
  level?: LoggingLevel,
) => void;
export type Logger = {
  [key in LoggingLevel]: (msg: string, metadata?: MessageMetadata) => void;
};

export type Tags =
  | 'invariant-violation'
  | 'state-transition'
  | 'invalid-request';

const cleanedLogFn = (log: LogFn) => {
  return (msg: string, metadata?: MessageMetadata) => {
    // skip cloning object if metadata has no transportMessage
    if (!metadata?.transportMessage) {
      log(msg, metadata);
      return;
    }

    // clone metadata and clean transportMessage
    const { payload, ...rest } = metadata.transportMessage;
    metadata.transportMessage = rest;
    log(msg, metadata);
  };
};

export type MessageMetadata = Partial<{
  protocolVersion: string;
  clientId: string;
  connectedTo: string;
  sessionId: string;
  connId: string;
  transportMessage: Partial<OpaqueTransportMessage>;
  validationErrors: Array<ValueError>;
  tags: Array<Tags>;
  telemetry: {
    traceId: string;
    spanId: string;
  };
}>;

export class BaseLogger implements Logger {
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

export const stringLogger: LogFn = (msg, ctx, level = 'info') => {
  const from = ctx?.clientId ? `${ctx.clientId} -- ` : '';
  console.log(`[river:${level}] ${from}${msg}`);
};

const colorMap = {
  debug: '\u001b[34m',
  info: '\u001b[32m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
};

export const coloredStringLogger: LogFn = (msg, ctx, level = 'info') => {
  const color = colorMap[level];
  const from = ctx?.clientId ? `${ctx.clientId} -- ` : '';
  console.log(`[river:${color}${level}\u001b[0m] ${from}${msg}`);
};

export const jsonLogger: LogFn = (msg, ctx, level) => {
  console.log(JSON.stringify({ msg, ctx, level }));
};

export const createLogProxy = (log: Logger) => ({
  debug: cleanedLogFn(log.debug.bind(log)),
  info: cleanedLogFn(log.info.bind(log)),
  warn: cleanedLogFn(log.warn.bind(log)),
  error: cleanedLogFn(log.error.bind(log)),
});
