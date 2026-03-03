/**
 * Extract the test server schema to a JSON file for codegen tests.
 *
 * Defines the same service schemas as test_server.ts but with stub
 * handlers — only the type shapes matter for serialization.
 *
 * Usage (from river repo root, after esbuild bundle):
 *   node python-client/tests/extract_test_schema.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  createServiceSchema,
  Procedure,
  Ok,
  serializeSchema,
} from '../../router';
import { Type } from '@sinclair/typebox';

const ServiceSchema = createServiceSchema();

const TestServiceSchema = ServiceSchema.define({
  add: Procedure.rpc({
    requestInit: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ result: Type.Number() }),
    responseError: Type.Never(),
    async handler({ reqInit }) {
      return Ok({ result: reqInit.n });
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
    async handler({ resWritable }) {
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
    async handler({ resWritable }) {
      resWritable.close();
    },
  }),
  echoBinary: Procedure.rpc({
    requestInit: Type.Object({ data: Type.Uint8Array() }),
    responseData: Type.Object({
      data: Type.Uint8Array(),
      length: Type.Number(),
    }),
    responseError: Type.Never(),
    async handler({ reqInit }) {
      return Ok({ data: reqInit.data, length: reqInit.data.length });
    },
  }),
});

const OrderingServiceSchema = ServiceSchema.define({
  add: Procedure.rpc({
    requestInit: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ n: Type.Number() }),
    responseError: Type.Never(),
    async handler({ reqInit }) {
      return Ok({ n: reqInit.n });
    },
  }),
  getAll: Procedure.rpc({
    requestInit: Type.Object({}),
    responseData: Type.Object({ msgs: Type.Array(Type.Number()) }),
    responseError: Type.Never(),
    async handler(_ctx) {
      return Ok({ msgs: [] as Array<number> });
    },
  }),
});

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
      return Ok({ result: reqInit.a / reqInit.b });
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
    async handler({ resWritable }) {
      resWritable.close();
    },
  }),
});

const SubscribableServiceSchema = ServiceSchema.define({
  add: Procedure.rpc({
    requestInit: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ result: Type.Number() }),
    responseError: Type.Never(),
    async handler({ reqInit }) {
      return Ok({ result: reqInit.n });
    },
  }),
  value: Procedure.subscription({
    requestInit: Type.Object({}),
    responseData: Type.Object({ count: Type.Number() }),
    responseError: Type.Never(),
    async handler({ resWritable }) {
      resWritable.write(Ok({ count: 0 }));
      resWritable.close();
    },
  }),
});

const UploadableServiceSchema = ServiceSchema.define({
  addMultiple: Procedure.upload({
    requestInit: Type.Object({}),
    requestData: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ result: Type.Number() }),
    responseError: Type.Never(),
    async handler(_ctx) {
      return Ok({ result: 0 });
    },
  }),
  addMultipleWithPrefix: Procedure.upload({
    requestInit: Type.Object({ prefix: Type.String() }),
    requestData: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ result: Type.String() }),
    responseError: Type.Never(),
    async handler(_ctx) {
      return Ok({ result: '' });
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
    async handler(_ctx) {
      return Ok({ result: 0 });
    },
  }),
});

const CancellationServiceSchema = ServiceSchema.define({
  blockingRpc: Procedure.rpc({
    requestInit: Type.Object({}),
    responseData: Type.Object({}),
    responseError: Type.Never(),
    async handler(_ctx) {
      return Ok({});
    },
  }),
  blockingStream: Procedure.stream({
    requestInit: Type.Object({}),
    requestData: Type.Object({}),
    responseData: Type.Object({}),
    responseError: Type.Never(),
    async handler({ resWritable }) {
      resWritable.close();
    },
  }),
  blockingUpload: Procedure.upload({
    requestInit: Type.Object({}),
    requestData: Type.Object({}),
    responseData: Type.Object({}),
    responseError: Type.Never(),
    async handler(_ctx) {
      return Ok({});
    },
  }),
  blockingSubscription: Procedure.subscription({
    requestInit: Type.Object({}),
    responseData: Type.Object({}),
    responseError: Type.Never(),
    async handler({ resWritable }) {
      resWritable.close();
    },
  }),
  immediateRpc: Procedure.rpc({
    requestInit: Type.Object({}),
    responseData: Type.Object({ done: Type.Boolean() }),
    responseError: Type.Never(),
    async handler(_ctx) {
      return Ok({ done: true });
    },
  }),
  immediateStream: Procedure.stream({
    requestInit: Type.Object({}),
    requestData: Type.Object({}),
    responseData: Type.Object({ done: Type.Boolean() }),
    responseError: Type.Never(),
    async handler({ resWritable }) {
      resWritable.close();
    },
  }),
  immediateUpload: Procedure.upload({
    requestInit: Type.Object({}),
    requestData: Type.Object({}),
    responseData: Type.Object({ done: Type.Boolean() }),
    responseError: Type.Never(),
    async handler(_ctx) {
      return Ok({ done: true });
    },
  }),
  immediateSubscription: Procedure.subscription({
    requestInit: Type.Object({}),
    responseData: Type.Object({ done: Type.Boolean() }),
    responseError: Type.Never(),
    async handler({ resWritable }) {
      resWritable.close();
    },
  }),
  countedStream: Procedure.stream({
    requestInit: Type.Object({ total: Type.Number() }),
    requestData: Type.Object({}),
    responseData: Type.Object({ i: Type.Number() }),
    responseError: Type.Never(),
    async handler({ resWritable }) {
      resWritable.close();
    },
  }),
});

const services = {
  test: TestServiceSchema,
  ordering: OrderingServiceSchema,
  fallible: FallibleServiceSchema,
  subscribable: SubscribableServiceSchema,
  uploadable: UploadableServiceSchema,
  cancel: CancellationServiceSchema,
};

const schema = serializeSchema(services);
const outPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  'test_schema.json',
);
fs.writeFileSync(outPath, JSON.stringify(schema, null, 2));
console.log(`Wrote schema to ${outPath}`);
