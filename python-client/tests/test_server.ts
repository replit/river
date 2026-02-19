/**
 * Standalone test server for the Python River client test suite.
 *
 * Starts a WebSocket server with the standard test services and prints
 * the port to stdout so the Python test harness can connect.
 *
 * Usage (from river repo root):
 *   npx tsx --tsconfig python-client/tsconfig.tsx.json python-client/tests/test_server.ts
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { WebSocketServerTransport } from '../../transport/impls/ws/server';
import {
  createServer,
  createServiceSchema,
  Procedure,
  Ok,
  Err,
} from '../../router';
import { Type } from '@sinclair/typebox';

const ServiceSchema = createServiceSchema();

// -------------------------------------------------------------------
// TestService – mirrors the TS TestServiceSchema
// -------------------------------------------------------------------
let count = 0;

const TestServiceSchema = ServiceSchema.define({
  add: Procedure.rpc({
    requestInit: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ result: Type.Number() }),
    responseError: Type.Never(),
    async handler({ reqInit }) {
      count += reqInit.n;
      return Ok({ result: count });
    },
  }),
  echo: Procedure.stream({
    requestInit: Type.Object({}),
    requestData: Type.Object({
      msg: Type.String(),
      ignore: Type.Optional(Type.Boolean()),
    }),
    responseData: Type.Object({ response: Type.String() }),
    responseError: Type.Never(),
    async handler({ reqReadable, resWritable }) {
      for await (const result of reqReadable) {
        if (!result.ok) break;
        const val = result.payload;
        if (val.ignore) continue;
        resWritable.write(Ok({ response: val.msg }));
      }
      resWritable.close();
    },
  }),
  echoWithPrefix: Procedure.stream({
    requestInit: Type.Object({ prefix: Type.String() }),
    requestData: Type.Object({
      msg: Type.String(),
      ignore: Type.Optional(Type.Boolean()),
    }),
    responseData: Type.Object({ response: Type.String() }),
    responseError: Type.Never(),
    async handler({ reqInit, reqReadable, resWritable }) {
      for await (const result of reqReadable) {
        if (!result.ok) break;
        const val = result.payload;
        if (val.ignore) continue;
        resWritable.write(Ok({ response: `${reqInit.prefix} ${val.msg}` }));
      }
      resWritable.close();
    },
  }),
});

// -------------------------------------------------------------------
// OrderingService – for message ordering tests
// -------------------------------------------------------------------
const msgs: number[] = [];

const OrderingServiceSchema = ServiceSchema.define({
  add: Procedure.rpc({
    requestInit: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ n: Type.Number() }),
    responseError: Type.Never(),
    async handler({ reqInit }) {
      msgs.push(reqInit.n);
      return Ok({ n: reqInit.n });
    },
  }),
  getAll: Procedure.rpc({
    requestInit: Type.Object({}),
    responseData: Type.Object({ msgs: Type.Array(Type.Number()) }),
    responseError: Type.Never(),
    async handler() {
      return Ok({ msgs: [...msgs] });
    },
  }),
});

// -------------------------------------------------------------------
// FallibleService – service-level errors
// -------------------------------------------------------------------
const FallibleServiceSchema = ServiceSchema.define({
  divide: Procedure.rpc({
    requestInit: Type.Object({ a: Type.Number(), b: Type.Number() }),
    responseData: Type.Object({ result: Type.Number() }),
    responseError: Type.Union([
      Type.Object({
        code: Type.Literal('DIV_BY_ZERO'),
        message: Type.String(),
      }),
      Type.Object({
        code: Type.Literal('INFINITY'),
        message: Type.String(),
      }),
    ]),
    async handler({ reqInit }) {
      if (reqInit.b === 0) {
        return Err({
          code: 'DIV_BY_ZERO' as const,
          message: 'Cannot divide by zero',
        });
      }
      const result = reqInit.a / reqInit.b;
      if (!isFinite(result)) {
        return Err({
          code: 'INFINITY' as const,
          message: 'Result is infinity',
        });
      }
      return Ok({ result });
    },
  }),
  echo: Procedure.stream({
    requestInit: Type.Object({}),
    requestData: Type.Object({
      msg: Type.String(),
      throwResult: Type.Optional(Type.Boolean()),
      throwError: Type.Optional(Type.Boolean()),
    }),
    responseData: Type.Object({ response: Type.String() }),
    responseError: Type.Object({
      code: Type.Literal('STREAM_ERROR'),
      message: Type.String(),
    }),
    async handler({ reqReadable, resWritable }) {
      for await (const result of reqReadable) {
        if (!result.ok) break;
        const val = result.payload;
        if (val.throwError) {
          throw new Error('uncaught error');
        }
        if (val.throwResult) {
          resWritable.write(
            Err({ code: 'STREAM_ERROR' as const, message: 'stream error' }),
          );
          continue;
        }
        resWritable.write(Ok({ response: val.msg }));
      }
      resWritable.close();
    },
  }),
});

// -------------------------------------------------------------------
// SubscribableService – subscriptions
// -------------------------------------------------------------------
let subCount = 0;
type SubListener = (val: number) => void;
const subListeners = new Set<SubListener>();

const SubscribableServiceSchema = ServiceSchema.define({
  add: Procedure.rpc({
    requestInit: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ result: Type.Number() }),
    responseError: Type.Never(),
    async handler({ reqInit }) {
      subCount += reqInit.n;
      for (const l of subListeners) l(subCount);
      return Ok({ result: subCount });
    },
  }),
  value: Procedure.subscription({
    requestInit: Type.Object({}),
    responseData: Type.Object({ count: Type.Number() }),
    responseError: Type.Never(),
    async handler({ resWritable, ctx }) {
      const listener: SubListener = (val) => {
        resWritable.write(Ok({ count: val }));
      };
      // Send initial value
      resWritable.write(Ok({ count: subCount }));
      subListeners.add(listener);
      ctx.signal.addEventListener('abort', () => {
        subListeners.delete(listener);
        resWritable.close();
      });
    },
  }),
});

// -------------------------------------------------------------------
// UploadableService – uploads
// -------------------------------------------------------------------
const UploadableServiceSchema = ServiceSchema.define({
  addMultiple: Procedure.upload({
    requestInit: Type.Object({}),
    requestData: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ result: Type.Number() }),
    responseError: Type.Never(),
    async handler({ reqReadable }) {
      let total = 0;
      for await (const result of reqReadable) {
        if (!result.ok) break;
        total += result.payload.n;
      }
      return Ok({ result: total });
    },
  }),
  addMultipleWithPrefix: Procedure.upload({
    requestInit: Type.Object({ prefix: Type.String() }),
    requestData: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ result: Type.String() }),
    responseError: Type.Never(),
    async handler({ reqInit, reqReadable }) {
      let total = 0;
      for await (const result of reqReadable) {
        if (!result.ok) break;
        total += result.payload.n;
      }
      return Ok({ result: `${reqInit.prefix} ${total}` });
    },
  }),
  cancellableAdd: Procedure.upload({
    requestInit: Type.Object({}),
    requestData: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ result: Type.Number() }),
    responseError: Type.Object({
      code: Type.Literal('CANCEL'),
      message: Type.String(),
    }),
    async handler({ reqReadable, ctx }) {
      let total = 0;
      for await (const result of reqReadable) {
        if (!result.ok) break;
        total += result.payload.n;
        if (total >= 10) {
          ctx.cancel();
          return Err({
            code: 'CANCEL' as const,
            message: 'total exceeds limit',
          });
        }
      }
      return Ok({ result: total });
    },
  }),
});

// -------------------------------------------------------------------
// Boot the server
// -------------------------------------------------------------------
const services = {
  test: TestServiceSchema,
  ordering: OrderingServiceSchema,
  fallible: FallibleServiceSchema,
  subscribable: SubscribableServiceSchema,
  uploadable: UploadableServiceSchema,
};

async function main() {
  const httpServer = http.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      if (typeof addr === 'object' && addr) resolve(addr.port);
      else reject(new Error("couldn't get port"));
    });
  });

  const wss = new WebSocketServer({ server: httpServer });
  const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
  const _server = createServer(serverTransport, services);

  // Signal that the server is ready by printing the port
  process.stdout.write(`RIVER_PORT=${port}\n`);

  // Keep the server alive
  process.on('SIGTERM', () => {
    _server.close().then(() => {
      httpServer.close();
      process.exit(0);
    });
  });
  process.on('SIGINT', () => {
    _server.close().then(() => {
      httpServer.close();
      process.exit(0);
    });
  });
}

main().catch((err) => {
  console.error('Failed to start test server:', err);
  process.exit(1);
});
