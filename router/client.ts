import { Service } from './builder';

interface ProxyCallbackOptions {
  path: string[];
  args: unknown[];
}

type ProxyCallback = (opts: ProxyCallbackOptions) => unknown;

const noop = () => {};

// should only be called internally
function _createRecursiveProxy(callback: ProxyCallback, path: string[]): unknown {
  const proxy: unknown = new Proxy(noop, {
    get(_obj, key) {
      if (typeof key !== 'string') return undefined;
      // Recursively compose the full path until a function is invoked
      return _createRecursiveProxy(callback, [...path, key]);
    },
    apply(_1, _2, args) {
      // Call the callback function with the entire path we
      // recursively created and forward the arguments
      return callback({
        path,
        args,
      });
    },
  });

  return proxy;
}

export const createTinyRPCClient = <
  TRouter extends Service<string, object, Record<string, unknown>>,
>(
  baseUrl: string,
) =>
  _createRecursiveProxy(async (opts) => {
    const path = [...opts.path]; // e.g. ["post", "byId", "query"]
    const method = path.pop()! as 'query' | 'mutate';
    const dotPath = path.join('.'); // "post.byId" - this is the path procedures have on the backend
    let uri = `${baseUrl}/${dotPath}`;

    const [input] = opts.args;
    // send this shit over transport
  }, []) as DecoratedProcedureRecord<TRouter['_def']['record']>;
