export interface IsomorphicEnvironment {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}
