/**
 * Standalone test server for the Python River client test suite.
 * Uses the built dist/ output so it works with plain Node.js.
 *
 * Usage:  node python-client/tests/test_server.mjs
 *         (run from the river repo root after `npx tsup`)
 */
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

// We import from the built output in dist/ (paths relative to river repo root)
import { createServer, createServiceSchema, Procedure, Ok, Err } from '../../dist/router/index.js';
import { WebSocketServerTransport } from '../../dist/transport/impls/ws/server.js';
import { Type } from '@sinclair/typebox';

const ServiceSchema = createServiceSchema();

// -------------------------------------------------------------------
// TestService
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
// OrderingService
// -------------------------------------------------------------------
const msgs = [];

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
// FallibleService
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
        return Err({ code: 'DIV_BY_ZERO', message: 'Cannot divide by zero' });
      }
      const result = reqInit.a / reqInit.b;
      if (!isFinite(result)) {
        return Err({ code: 'INFINITY', message: 'Result is infinity' });
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
            Err({ code: 'STREAM_ERROR', message: 'stream error' }),
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
// SubscribableService
// -------------------------------------------------------------------
let subCount = 0;
const subListeners = new Set();

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
      const listener = (val) => {
        resWritable.write(Ok({ count: val }));
      };
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
// UploadableService
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
          return Err({ code: 'CANCEL', message: 'total exceeds limit' });
        }
      }
      return Ok({ result: total });
    },
  }),
});

// -------------------------------------------------------------------
// Boot
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
  const port = await new Promise((resolve, reject) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      if (typeof addr === 'object' && addr) resolve(addr.port);
      else reject(new Error("couldn't get port"));
    });
  });

  const wss = new WebSocketServer({ server: httpServer });
  const serverTransport = new WebSocketServerTransport(wss, 'SERVER');
  const _server = createServer(serverTransport, services);

  // Print port so the Python test can parse it
  process.stdout.write(`RIVER_PORT=${port}\n`);

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
