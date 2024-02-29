export function coerceErrorString(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name} (${err.message})`;
  }

  return `[coerced to error] ${String(err)}`;
}
