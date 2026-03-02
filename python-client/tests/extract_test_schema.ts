/**
 * Extract the test server schema to a JSON file for codegen tests.
 *
 * Usage (from river repo root):
 *   node python-client/tests/extract_test_schema.mjs
 *
 * Outputs: python-client/tests/test_schema.json
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createServiceSchema,
  Procedure,
  Ok,
  Err,
  serializeSchema,
} from '../../router';
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
const msgs: Array<number> = [];

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
        return Err({ code: 'DIV_BY_ZERO' as const, message: 'Cannot divide by zero' });
      }
      const result = reqInit.a / reqInit.b;
      if (!isFinite(result)) {
        return Err({ code: 'INFINITY' as const, message: 'Result is infinity' });
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
        if (val.throwError) throw new Error('uncaught error');
        if (val.throwResult) {
          resWritable.write(Err({ code: 'STREAM_ERROR' as const, message: 'stream error' }));
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
      resWritable.write(Ok({ count: subCount }));
      const listener: SubListener = (val) => {
        resWritable.write(Ok({ count: val }));
      };
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
          return Err({ code: 'CANCEL' as const, message: 'total exceeds limit' });
        }
      }
      return Ok({ result: total });
    },
  }),
});

// -------------------------------------------------------------------
// CancellationService
// -------------------------------------------------------------------
const CancellationServiceSchema = ServiceSchema.define({
  blockingRpc: Procedure.rpc({
    requestInit: Type.Object({}),
    responseData: Type.Object({}),
    responseError: Type.Never(),
    async handler({ ctx }) {
      return new Promise<never>((_resolve) => {
        ctx.signal.addEventListener('abort', () => {});
      });
    },
  }),
  blockingStream: Procedure.stream({
    requestInit: Type.Object({}),
    requestData: Type.Object({}),
    responseData: Type.Object({}),
    responseError: Type.Never(),
    async handler(_ctx) {
      return new Promise<void>(() => {});
    },
  }),
  blockingUpload: Procedure.upload({
    requestInit: Type.Object({}),
    requestData: Type.Object({}),
    responseData: Type.Object({}),
    responseError: Type.Never(),
    async handler(_ctx) {
      return new Promise<never>(() => {});
    },
  }),
  blockingSubscription: Procedure.subscription({
    requestInit: Type.Object({}),
    responseData: Type.Object({}),
    responseError: Type.Never(),
    async handler(_ctx) {
      return new Promise<void>(() => {});
    },
  }),
  immediateRpc: Procedure.rpc({
    requestInit: Type.Object({}),
    responseData: Type.Object({ done: Type.Boolean() }),
    responseError: Type.Never(),
    async handler() {
      return Ok({ done: true });
    },
  }),
  immediateStream: Procedure.stream({
    requestInit: Type.Object({}),
    requestData: Type.Object({}),
    responseData: Type.Object({ done: Type.Boolean() }),
    responseError: Type.Never(),
    async handler({ reqReadable, resWritable }) {
      resWritable.write(Ok({ done: true }));
      for await (const result of reqReadable) {
        if (!result.ok) break;
      }
      resWritable.close();
    },
  }),
  immediateUpload: Procedure.upload({
    requestInit: Type.Object({}),
    requestData: Type.Object({}),
    responseData: Type.Object({ done: Type.Boolean() }),
    responseError: Type.Never(),
    async handler({ reqReadable }) {
      for await (const result of reqReadable) {
        if (!result.ok) break;
      }
      return Ok({ done: true });
    },
  }),
  immediateSubscription: Procedure.subscription({
    requestInit: Type.Object({}),
    responseData: Type.Object({ done: Type.Boolean() }),
    responseError: Type.Never(),
    async handler({ resWritable }) {
      resWritable.write(Ok({ done: true }));
      resWritable.close();
    },
  }),
  countedStream: Procedure.stream({
    requestInit: Type.Object({ total: Type.Number() }),
    requestData: Type.Object({}),
    responseData: Type.Object({ i: Type.Number() }),
    responseError: Type.Never(),
    async handler({ reqInit, reqReadable, resWritable }) {
      for (let i = 0; i < reqInit.total; i++) {
        resWritable.write(Ok({ i }));
      }
      for await (const result of reqReadable) {
        if (!result.ok) break;
      }
      resWritable.close();
    },
  }),
});

// -------------------------------------------------------------------
// Serialize and write
// -------------------------------------------------------------------
const services = {
  test: TestServiceSchema,
  ordering: OrderingServiceSchema,
  fallible: FallibleServiceSchema,
  subscribable: SubscribableServiceSchema,
  uploadable: UploadableServiceSchema,
  cancel: CancellationServiceSchema,
};

const schema = serializeSchema(services);
const outPath = path.join(path.dirname(new URL(import.meta.url).pathname), 'test_schema.json');
fs.writeFileSync(outPath, JSON.stringify(schema, null, 2));
console.log(`Wrote schema to ${outPath}`);
