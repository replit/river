import { Transport } from '../transport/types';
import { AnyService, ProcInput, ProcOutput, ProcType } from './builder';
import { pushable } from 'it-pushable';
import type { Pushable } from 'it-pushable';
import { Server } from './server';
import {
  OpaqueTransportMessage,
  ControlFlags,
  msg,
} from '../transport/message';
import { Static } from '@sinclair/typebox';
import { waitForMessage } from '../transport';
import { nanoid } from 'nanoid';

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
    // property access, recurse and add field to path
    get(_obj, key) {
      if (typeof key !== 'string') return undefined;
      return _createRecursiveProxy(callback, [...path, key]);
    },
    // hit the end, let's invoke the handler
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
    const streamId = nanoid();

    function belongsToSameStream(msg: OpaqueTransportMessage) {
      return (
        msg.streamId === streamId &&
        msg.serviceName === serviceName &&
        msg.procedureName === procName
      );
    }

    if (input === undefined) {
      // stream case (stream methods are called with zero arguments)
      const inputStream = pushable({ objectMode: true });
      const outputStream = pushable({ objectMode: true });

      // input -> transport
      // this gets cleaned up on i.end() which is called by closeHandler
      (async () => {
        for await (const rawIn of inputStream) {
          const m = msg(
            transport.clientId,
            'SERVER',
            serviceName,
            procName,
            streamId,
            rawIn as object,
          );

          m.controlFlags |= ControlFlags.StreamOpenBit;
          transport.send(m);
        }
      })();

      // transport -> output
      const listener = (msg: OpaqueTransportMessage) => {
        if (belongsToSameStream(msg)) {
          outputStream.push(msg.payload);
        }
      };

      transport.addMessageListener(listener);
      const closeHandler = () => {
        inputStream.end();
        outputStream.end();
        const closeMessage = msg(
          transport.clientId,
          'SERVER',
          serviceName,
          procName,
          streamId,
          {},
        );
        closeMessage.controlFlags |= ControlFlags.StreamClosedBit;
        transport.send(closeMessage);
        transport.removeMessageListener(listener);
      };

      return [inputStream, outputStream, closeHandler];
    } else {
      // rpc case
      const m = msg(
        transport.clientId,
        'SERVER',
        serviceName,
        procName,
        streamId,
        input as object,
      );

      m.controlFlags |=
        ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit;
      transport.send(m);
      return waitForMessage(transport, belongsToSameStream);
    }
  }, []) as ServerClient<Srv>;
