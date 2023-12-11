import { Connection, Transport } from '../transport/transport';
import {
  AnyService,
  ProcErrors,
  ProcHasInit,
  ProcInit,
  ProcInput,
  ProcOutput,
  ProcType,
} from './builder';
import { pushable } from 'it-pushable';
import type { Pushable } from 'it-pushable';
import { Server } from './server';
import {
  OpaqueTransportMessage,
  ControlFlags,
  msg,
  TransportClientId,
  isStreamClose,
  closeStream,
} from '../transport/message';
import { Static } from '@sinclair/typebox';
import { waitForMessage } from '../transport';
import { nanoid } from 'nanoid';
import { Result } from './result';

// helper to make next, yield, and return all the same type
type AsyncIter<T> = AsyncGenerator<T, T, unknown>;

/**
 * A helper type to transform an actual service type into a type
 * we can case to in the proxy.
 * @template Router - The type of the Router.
 */
type ServiceClient<Router extends AnyService> = {
  [ProcName in keyof Router['procedures']]: ProcType<
    Router,
    ProcName
  > extends 'rpc'
    ? {
        rpc: (
          input: Static<ProcInput<Router, ProcName>>,
        ) => Promise<
          Result<
            Static<ProcOutput<Router, ProcName>>,
            Static<ProcErrors<Router, ProcName>>
          >
        >;
      }
    : ProcType<Router, ProcName> extends 'upload'
    ? ProcHasInit<Router, ProcName> extends true
      ? {
          upload: (init: Static<ProcInit<Router, ProcName>>) => Promise<
            [
              Pushable<Static<ProcInput<Router, ProcName>>>, // input
              Promise<
                Result<
                  Static<ProcOutput<Router, ProcName>>,
                  Static<ProcErrors<Router, ProcName>>
                >
              >, // output
            ]
          >;
        }
      : {
          upload: () => Promise<
            [
              Pushable<Static<ProcInput<Router, ProcName>>>, // input
              Promise<
                Result<
                  Static<ProcOutput<Router, ProcName>>,
                  Static<ProcErrors<Router, ProcName>>
                >
              >, // output
            ]
          >;
        }
    : ProcType<Router, ProcName> extends 'stream'
    ? ProcHasInit<Router, ProcName> extends true
      ? {
          stream: (init: Static<ProcInit<Router, ProcName>>) => Promise<
            [
              Pushable<Static<ProcInput<Router, ProcName>>>, // input
              AsyncIter<
                Result<
                  Static<ProcOutput<Router, ProcName>>,
                  Static<ProcErrors<Router, ProcName>>
                >
              >, // output
              () => void, // close handle
            ]
          >;
        }
      : {
          stream: () => Promise<
            [
              Pushable<Static<ProcInput<Router, ProcName>>>, // input
              AsyncIter<
                Result<
                  Static<ProcOutput<Router, ProcName>>,
                  Static<ProcErrors<Router, ProcName>>
                >
              >, // output
              () => void, // close handle
            ]
          >;
        }
    : ProcType<Router, ProcName> extends 'subscription'
    ? {
        subscribe: (input: Static<ProcInput<Router, ProcName>>) => Promise<
          [
            AsyncIter<
              Result<
                Static<ProcOutput<Router, ProcName>>,
                Static<ProcErrors<Router, ProcName>>
              >
            >, // output
            () => void, // close handle
          ]
        >;
      }
    : never;
};

/**
 * Defines a type that represents a client for a server with a set of services.
 * @template Srv - The type of the server.
 */
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

/**
 * Creates a client for a given server using the provided transport.
 * Note that the client only needs the type of the server, not the actual
 * server definition itself.
 *
 * This relies on a proxy to dynamically create the client, so the client
 * will be typed as if it were the actual server with the appropriate services
 * and procedures.
 *
 * @template Srv - The type of the server.
 * @param {Transport} transport - The transport to use for communication.
 * @returns The client for the server.
 */
export const createClient = <Srv extends Server<Record<string, AnyService>>>(
  transport: Transport<Connection>,
  serverId: TransportClientId = 'SERVER',
) =>
  _createRecursiveProxy(async (opts) => {
    const [serviceName, procName, procType] = [...opts.path];
    if (!(serviceName && procName && procType)) {
      throw new Error(
        'invalid river call, ensure the service and procedure you are calling exists',
      );
    }

    const [input] = opts.args;
    const streamId = nanoid();

    function belongsToSameStream(msg: OpaqueTransportMessage) {
      return (
        msg.serviceName === serviceName &&
        msg.procedureName === procName &&
        msg.streamId === streamId
      );
    }

    if (procType === 'stream') {
      const inputStream = pushable({ objectMode: true });
      const outputStream = pushable({ objectMode: true });
      let firstMessage = true;

      if (input) {
        const m = msg(
          transport.clientId,
          serverId,
          serviceName,
          procName,
          streamId,
          input as object,
        );

        // first message needs the open bit.
        m.controlFlags = ControlFlags.StreamOpenBit;
        transport.send(m);
        firstMessage = false;
      }

      // input -> transport
      // this gets cleaned up on inputStream.end() which is called by closeHandler
      (async () => {
        for await (const rawIn of inputStream) {
          const m = msg(
            transport.clientId,
            serverId,
            serviceName,
            procName,
            streamId,
            rawIn as object,
          );

          if (firstMessage) {
            m.controlFlags |= ControlFlags.StreamOpenBit;
            firstMessage = false;
          }

          transport.send(m);
        }
      })();

      // transport -> output
      const listener = (msg: OpaqueTransportMessage) => {
        if (isStreamClose(msg.controlFlags)) {
          outputStream.end();
        } else if (belongsToSameStream(msg)) {
          outputStream.push(msg.payload);
        }
      };

      transport.addMessageListener(listener);
      const closeHandler = () => {
        inputStream.end();
        outputStream.end();
        transport.send(
          closeStream(
            transport.clientId,
            serverId,
            serviceName,
            procName,
            streamId,
          ),
        );
        transport.removeMessageListener(listener);
      };

      return [inputStream, outputStream, closeHandler];
    } else if (procType === 'rpc') {
      const m = msg(
        transport.clientId,
        serverId,
        serviceName,
        procName,
        streamId,
        input as object,
      );

      // rpc is a stream open + close
      m.controlFlags |=
        ControlFlags.StreamOpenBit | ControlFlags.StreamClosedBit;
      transport.send(m);
      return waitForMessage(transport, belongsToSameStream);
    } else if (procType === 'subscribe') {
      const m = msg(
        transport.clientId,
        serverId,
        serviceName,
        procName,
        streamId,
        input as object,
      );
      m.controlFlags |= ControlFlags.StreamOpenBit;
      transport.send(m);

      // transport -> output
      const outputStream = pushable({ objectMode: true });
      const listener = (msg: OpaqueTransportMessage) => {
        if (belongsToSameStream(msg)) {
          outputStream.push(msg.payload);
        }

        if (isStreamClose(msg.controlFlags)) {
          outputStream.end();
        }
      };

      transport.addMessageListener(listener);
      const closeHandler = () => {
        outputStream.end();
        transport.send(
          closeStream(
            transport.clientId,
            serverId,
            serviceName,
            procName,
            streamId,
          ),
        );
        transport.removeMessageListener(listener);
      };

      return [outputStream, closeHandler];
    } else if (procType === 'upload') {
      const inputStream = pushable({ objectMode: true });
      let firstMessage = true;

      if (input) {
        const m = msg(
          transport.clientId,
          serverId,
          serviceName,
          procName,
          streamId,
          input as object,
        );

        // first message needs the open bit.
        m.controlFlags = ControlFlags.StreamOpenBit;
        transport.send(m);
        firstMessage = false;
      }

      // input -> transport
      // this gets cleaned up on inputStream.end(), which the caller should call.
      (async () => {
        for await (const rawIn of inputStream) {
          const m = msg(
            transport.clientId,
            serverId,
            serviceName,
            procName,
            streamId,
            rawIn as object,
          );

          if (firstMessage) {
            m.controlFlags |= ControlFlags.StreamOpenBit;
            firstMessage = false;
          }

          transport.send(m);
        }

        transport.send(
          closeStream(
            transport.clientId,
            serverId,
            serviceName,
            procName,
            streamId,
          ),
        );
      })();

      return [inputStream, waitForMessage(transport, belongsToSameStream)];
    } else {
      throw new Error(`invalid river call, unknown procedure type ${procType}`);
    }
  }, []) as ServerClient<Srv>;
