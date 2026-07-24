export interface PromiseWithResolvers<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/**
 * @internal
 *
 * Same as https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/withResolvers
 * but we support versions where it doesn't exist
 */
export function createPromiseWithResolvers<T>(): PromiseWithResolvers<T> {
  let resolve: (value: T) => void;
  let reject: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return {
    promise,
    // @ts-expect-error promise callbacks are sync
    resolve,
    // @ts-expect-error promise callbacks are sync
    reject,
  };
}
