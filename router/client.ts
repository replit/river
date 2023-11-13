import { Transport } from '../transport/types';
import { AnyService, ProcInput, ProcOutput, ProcType } from './builder';
import { pushable } from 'it-pushable';
import type { Pushable } from 'it-pushable';
import { Server } from './server';
import {
  OpaqueTransportMessage,
  StreamClosedBit,
  StreamOpenBit,
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
    const streamId = nanoid();

    if (input === undefined) {
      // stream case
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

          m.controlFlags |= StreamOpenBit;
          transport.send(m);
        }
      })();

      // transport -> output
      const listener = (msg: OpaqueTransportMessage) => {
        // stream id is enough to guarantee uniqueness
        // but let's enforce extra invariants here
        if (
          msg.streamId === streamId &&
          msg.serviceName === serviceName &&
          msg.procedureName === procName
        ) {
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
        closeMessage.controlFlags |= StreamClosedBit;

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

      m.controlFlags |= StreamOpenBit;
      m.controlFlags |= StreamClosedBit;
      transport.send(m);
      return waitForMessage(
        transport,
        (msg) =>
          msg.streamId === streamId &&
          msg.serviceName === serviceName &&
          msg.procedureName === procName,
      );
    }
  }, []) as ServerClient<Srv>;
