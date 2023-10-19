const LoggingLevels = {
  info: 0,
  warn: 1,
  error: 2,
} as const;

type LoggingLevel = keyof typeof LoggingLevels;
export type Logger = {
  minLevel: LoggingLevel;
} & {
  [key in LoggingLevel]: (msg: string) => void;
};

export let log: Logger | undefined;
const defaultLoggingLevel: LoggingLevel = 'warn';

export function bindLogger(write: (msg: string) => void, color?: boolean) {
  const info = color ? '\u001b[37minfo\u001b[0m' : 'info';
  const warn = color ? '\u001b[33mwarn\u001b[0m' : 'warn';
  const error = color ? '\u001b[31merr\u001b[0m' : 'err';

  log = {
    info: (msg) =>
      log &&
      LoggingLevels[log.minLevel] <= 0 &&
      write(`[river:${info}] ${msg}`),
    warn: (msg) =>
      log &&
      LoggingLevels[log.minLevel] <= 1 &&
      write(`[river:${warn}] ${msg}`),
    error: (msg) =>
      log &&
      LoggingLevels[log.minLevel] <= 2 &&
      write(`[river:${error}] ${msg}`),
    minLevel: log?.minLevel ?? defaultLoggingLevel,
  };
}

export function setLevel(level: LoggingLevel) {
  if (log) {
    log.minLevel = level;
  }
}
