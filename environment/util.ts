import { IsomorphicEnvironment } from './types';

export function createTestEnvironment(): IsomorphicEnvironment {
  return {
    log: (...args: unknown[]) => {
      console.log(...args);
    },
    error: (...args: unknown[]) => {
      console.error(...args);
    },
  };
}
