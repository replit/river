import http from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Type } from 'typebox';
import { Ok, Procedure, createServiceSchema, createServer } from '../router';
import { INVALID_REQUEST_CODE } from '../router/errors';
import { WebSocketServerTransport } from '../transport/impls/ws/server';
import { WebSocketClientTransport } from '../transport/impls/ws/client';
import {
  createLocalWebSocketClient,
  createWebSocketServer,
  getClientSendFn,
  onWsServerReady,
} from '../testUtil';
import { waitFor } from '../testUtil/fixtures/cleanup';
import { ControlFlags } from '../transport/message';
import type { EventMap } from '../transport';

/**
 * RiverServer resolves the service and procedure named in a stream-open frame
 * with the `in` operator on plain objects, so names inherited from
 * Object.prototype (`toString`, `constructor`, `__proto__`, ...) pass the
 * existence check. For an inherited *service* name, `service.procedures` is
 * undefined and the next `in` throws a TypeError synchronously inside the
 * ws 'message' listener -- an uncaught exception that kills the server
 * process. One frame from any client that can complete a handshake is enough.
 */
const ServiceSchema = createServiceSchema();

describe('stream-open with Object.prototype names over a real websocket', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  async function setup() {
    const uncaught: Array<unknown> = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.prependListener('uncaughtException', onUncaught);

    const server = http.createServer();
    const port = await onWsServerReady(server);
    const wss = createWebSocketServer(server);
    const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
    createServer(serverTransport, {
      svc: ServiceSchema.define({
        rpc: Procedure.rpc({
          requestInit: Type.Object({}),
          responseData: Type.Object({}),
          handler: async () => Ok({}),
        }),
      }),
    });

    const clientTransport = new WebSocketClientTransport(
      () => Promise.resolve(createLocalWebSocketClient(port)),
      'client',
    );
    clientTransport.connect('SERVER');
    const onMessage = vi.fn<(msg: EventMap['message']) => void>();
    clientTransport.addEventListener('message', onMessage);

    cleanups.push(() => {
      process.removeListener('uncaughtException', onUncaught);
      clientTransport.close();
      serverTransport.close();
      wss.close();
      server.close();
    });

    return {
      uncaught,
      onMessage,
      send: getClientSendFn(clientTransport, serverTransport),
    };
  }

  test.each([
    { serviceName: 'toString', procedureName: 'x' },
    { serviceName: 'constructor', procedureName: 'x' },
    { serviceName: '__proto__', procedureName: 'x' },
    { serviceName: 'hasOwnProperty', procedureName: 'x' },
    // valid service, inherited procedure name: no crash, but the stream is
    // never answered because `procedure.type` is undefined
    { serviceName: 'svc', procedureName: 'constructor' },
  ])(
    'serviceName=$serviceName procedureName=$procedureName is rejected as INVALID_REQUEST',
    async ({ serviceName, procedureName }) => {
      const { uncaught, onMessage, send } = await setup();
      const streamId = `stream-${serviceName}-${procedureName}`;

      send({
        streamId,
        serviceName,
        procedureName,
        payload: {},
        controlFlags: ControlFlags.StreamOpenBit,
      });

      await waitFor(() => {
        expect(onMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            streamId,
            controlFlags: ControlFlags.StreamCancelBit,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            payload: expect.objectContaining({
              ok: false,
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
              payload: expect.objectContaining({ code: INVALID_REQUEST_CODE }),
            }),
          }),
        );
      });
      expect(uncaught).toEqual([]);
    },
  );
});
