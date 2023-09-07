import { Transport } from '../transport/types';
import { Service } from './builder';
import { Pushable } from 'it-pushable';
import { Server } from './server';

interface ProxyCallbackOptions {
  path: string[];
  args: unknown[];
}

type ProxyCallback = (opts: ProxyCallbackOptions) => unknown;

const noop = () => {};

type IterableToPushable<T> = T extends AsyncIterable<infer U> ? Pushable<U> : never;
type PushableToIterable<T> = T extends Pushable<infer U> ? AsyncIterable<U> : never;

type ServiceClient<Router extends Service> = {
  [ProcName in keyof Router['procedures']]: Router['procedures'][ProcName]['type'] extends 'rpc'
    ? // rpc case
      (
        input: Parameters<Router['procedures'][ProcName]['handler']>[1],
      ) => Promise<ReturnType<Router['procedures'][ProcName]['handler']>>
    : // stream case
      (
        input: IterableToPushable<Parameters<Router['procedures'][ProcName]['handler']>[1]>,
      ) => Promise<PushableToIterable<Parameters<Router['procedures'][ProcName]['handler']>[2]>>;
};

export type ServerClient<Srv extends Server<Record<string, Service>>> = {
  [SvcName in keyof Srv['services']]: ServiceClient<Srv['services'][SvcName]>;
};

// should only be called internally
function _createRecursiveProxy(callback: ProxyCallback, path: string[]): unknown {
  const proxy: unknown = new Proxy(noop, {
    get(_obj, key) {
      if (typeof key !== 'string') return undefined;
      return _createRecursiveProxy(callback, [...path, key]);
    },
    apply(_1, _2, args) {
      return callback({
        path,
        args,
      });
    },
  });

  return proxy;
}

export const createClient = <Srv extends Server<Record<string, Service>>>(
  transport: Transport,
  server: Srv,
) =>
  _createRecursiveProxy(async (opts) => {
    const [serviceName, procName] = [...opts.path];
    const dotPath = path.join('.');

    const [input] = opts.args;
    // send this shit over transport
  }, []) as ServerClient<Srv>;
