export function coerceErrorString(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }

  return `[coerced to error] ${String(err)}`;
}
