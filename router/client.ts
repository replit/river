import { Transport } from '../transport/types';
import { AnyService, ProcInput, ProcOutput, ProcType } from './builder';
import { pushable } from 'it-pushable';
import type { Pushable } from 'it-pushable';
import { Server } from './server';
import { OpaqueTransportMessage, msg } from '../transport/message';
import { Static } from '@sinclair/typebox';
import { waitForMessage } from '../transport/util';

type ServiceClient<Router extends AnyService> = {
  [ProcName in keyof Router['procedures']]: ProcType<
    Router,
    ProcName
  > extends 'rpc'
    ? // rpc case
      (
        input: Static<ProcInput<Router, ProcName>>,
      ) => Promise<Static<ProcOutput<Router, ProcName>>>
    : // get stream case
      () => Promise<
        [
          Pushable<Static<ProcInput<Router, ProcName>>>, // input
          AsyncIterableIterator<Static<ProcOutput<Router, ProcName>>>, // output
          () => void, // close handle
        ]
      >;
};

export type ServerClient<Srv extends Server<Record<string, AnyService>>> = {
  [SvcName in keyof Srv['services']]: ServiceClient<Srv['services'][SvcName]>;
};

interface ProxyCallbackOptions {
  path: string[];
  args: unknown[];
}

type ProxyCallback = (opts: ProxyCallbackOptions) => unknown;
const noop = () => {};

function _createRecursiveProxy(
  callback: ProxyCallback,
  path: string[],
): unknown {
  const proxy: unknown = new Proxy(noop, {
    get(_obj, key) {
      if (typeof key !== 'string') return undefined;
      return _createRecursiveProxy(callback, [...path, key]);
    },
    apply(_target, _this, args) {
      return callback({
        path,
        args,
      });
    },
  });

  return proxy;
}

export const createClient = <Srv extends Server<Record<string, AnyService>>>(
  transport: Transport,
) =>
  _createRecursiveProxy(async (opts) => {
    const [serviceName, procName] = [...opts.path];
    const [input] = opts.args;

    if (input === undefined) {
      // stream case
      const i = pushable({ objectMode: true });
      const o = pushable({ objectMode: true });

      // i -> transport
      // this gets cleaned up on i.end() which is called by closeHandler
      (async () => {
        for await (const rawIn of i) {
          await transport.send(
            msg(
              transport.clientId,
              'SERVER',
              serviceName,
              procName,
              rawIn as object,
            ),
          );
        }
      })();

      // transport -> o
      const listener = (msg: OpaqueTransportMessage) => {
        if (msg.serviceName === serviceName && msg.procedureName === procName) {
          o.push(msg.payload);
        }
      };

      transport.addMessageListener(listener);
      const closeHandler = () => {
        i.end();
        o.end();
        transport.removeMessageListener(listener);
      };

      return [i, o, closeHandler];
    } else {
      // rpc case
      const id = await transport.send(
        msg(
          transport.clientId,
          'SERVER',
          serviceName,
          procName,
          input as object,
        ),
      );

      return waitForMessage(transport, (msg) => msg.replyTo === id);
    }
  }, []) as ServerClient<Srv>;
