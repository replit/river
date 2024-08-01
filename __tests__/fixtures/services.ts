import { Type } from '@sinclair/typebox';
import { ServiceSchema } from '../../router/services';
import { Err, Ok, unwrap } from '../../router/result';
import { Observable } from './observable';
import { Procedure } from '../../router';

export const EchoRequest = Type.Object({
  msg: Type.String(),
  ignore: Type.Boolean(),
});
export const EchoResponse = Type.Object({ response: Type.String() });

const TestServiceScaffold = ServiceSchema.scaffold({
  initializeState: () => ({ count: 0 }),
});

const testServiceProcedures = TestServiceScaffold.procedures({
  add: Procedure.rpc({
    requestInit: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ result: Type.Number() }),
    async handler({ ctx, reqInit: { n } }) {
      ctx.state.count += n;
      return Ok({ result: ctx.state.count });
    },
  }),

  array: Procedure.rpc({
    requestInit: Type.Object({ n: Type.Number() }),
    responseData: Type.Array(Type.Number()),
    async handler({ ctx, reqInit: { n } }) {
      ctx.state.count += n;
      return Ok([ctx.state.count]);
    },
  }),

  arrayStream: Procedure.stream({
    requestInit: Type.Object({}),
    requestData: Type.Object({ n: Type.Number() }),
    responseData: Type.Array(Type.Number()),
    async handler({ reqReader, resWriter }) {
      for await (const msg of reqReader) {
        resWriter.write(Ok([unwrap(msg).n]));
      }
    },
  }),

  echo: Procedure.stream({
    requestInit: Type.Object({}),
    requestData: EchoRequest,
    responseData: EchoResponse,
    async handler({ reqReader, resWriter }) {
      for await (const input of reqReader) {
        const { ignore, msg } = unwrap(input);
        if (!ignore) {
          resWriter.write(Ok({ response: msg }));
        }
      }

      resWriter.close();
    },
  }),

  echoWithPrefix: Procedure.stream({
    requestInit: Type.Object({ prefix: Type.String() }),
    requestData: EchoRequest,
    responseData: EchoResponse,
    async handler({ reqInit, reqReader, resWriter }) {
      for await (const input of reqReader) {
        const { ignore, msg } = unwrap(input);
        if (!ignore) {
          resWriter.write(Ok({ response: `${reqInit.prefix} ${msg}` }));
        }
      }

      resWriter.close();
    },
  }),

  echoUnion: Procedure.rpc({
    description: 'Echos back whatever we sent',
    requestInit: Type.Union([
      Type.Object(
        { a: Type.Number({ description: 'A number' }) },
        { description: 'A' },
      ),
      Type.Object(
        { b: Type.String({ description: 'A string' }) },
        { description: 'B' },
      ),
    ]),
    responseData: Type.Union([
      Type.Object(
        { a: Type.Number({ description: 'A number' }) },
        { description: 'A' },
      ),
      Type.Object(
        { b: Type.String({ description: 'A string' }) },
        { description: 'B' },
      ),
    ]),
    async handler({ reqInit }) {
      return Ok(reqInit);
    },
  }),

  unimplementedUpload: Procedure.upload({
    requestInit: Type.Object({}),
    requestData: Type.Object({}),
    responseData: Type.Object({}),
    async handler() {
      throw new Error('Not implemented');
    },
  }),

  unimplementedSubscription: Procedure.subscription({
    requestInit: Type.Object({}),
    responseData: Type.Object({}),
    async handler() {
      throw new Error('Not implemented');
    },
  }),
});

export const TestServiceSchema = TestServiceScaffold.finalize({
  ...testServiceProcedures,
});

export const OrderingServiceSchema = ServiceSchema.define(
  { initializeState: () => ({ msgs: [] as Array<number> }) },
  {
    add: Procedure.rpc({
      requestInit: Type.Object({ n: Type.Number() }),
      responseData: Type.Object({ n: Type.Number() }),
      async handler({ ctx, reqInit: { n } }) {
        ctx.state.msgs.push(n);
        return Ok({ n });
      },
    }),

    getAll: Procedure.rpc({
      requestInit: Type.Object({}),
      responseData: Type.Object({ msgs: Type.Array(Type.Number()) }),
      async handler({ ctx }) {
        return Ok({ msgs: ctx.state.msgs });
      },
    }),
  },
);

export const BinaryFileServiceSchema = ServiceSchema.define({
  getFile: Procedure.rpc({
    requestInit: Type.Object({ file: Type.String() }),
    responseData: Type.Object({ contents: Type.Uint8Array() }),
    async handler({ reqInit: { file } }) {
      const bytes: Uint8Array = Buffer.from(`contents for file ${file}`);
      return Ok({ contents: bytes });
    },
  }),
});

export const DIV_BY_ZERO = 'DIV_BY_ZERO';
export const STREAM_ERROR = 'STREAM_ERROR';

export const FallibleServiceSchema = ServiceSchema.define({
  divide: Procedure.rpc({
    requestInit: Type.Object({ a: Type.Number(), b: Type.Number() }),
    responseData: Type.Object({ result: Type.Number() }),
    responseError: Type.Union([
      Type.Object({
        code: Type.Literal(DIV_BY_ZERO),
        message: Type.String(),
        extras: Type.Object({ test: Type.String() }),
      }),
    ]),
    async handler({ reqInit: { a, b } }) {
      if (b === 0) {
        return Err({
          code: DIV_BY_ZERO,
          message: 'Cannot divide by zero',
          extras: { test: 'abc' },
        });
      } else {
        return Ok({ result: a / b });
      }
    },
  }),

  echo: Procedure.stream({
    requestInit: Type.Object({}),
    requestData: Type.Object({
      msg: Type.String(),
      throwResult: Type.Boolean(),
      throwError: Type.Boolean(),
    }),
    responseData: Type.Object({ response: Type.String() }),
    responseError: Type.Object({
      code: Type.Literal(STREAM_ERROR),
      message: Type.String(),
    }),
    async handler({ reqReader, resWriter }) {
      for await (const input of reqReader) {
        const { msg, throwError, throwResult } = unwrap(input);
        if (throwError) {
          throw new Error('some message');
        } else if (throwResult) {
          resWriter.write(
            Err({
              code: STREAM_ERROR,
              message: 'field throwResult was set to true',
            }),
          );
        } else {
          resWriter.write(Ok({ response: msg }));
        }
      }
    },
  }),
});

export const SubscribableServiceSchema = ServiceSchema.define(
  { initializeState: () => ({ count: new Observable(0) }) },
  {
    add: Procedure.rpc({
      requestInit: Type.Object({ n: Type.Number() }),
      responseData: Type.Object({ result: Type.Number() }),
      async handler({ ctx, reqInit: { n } }) {
        ctx.state.count.set((prev) => prev + n);
        return Ok({ result: ctx.state.count.get() });
      },
    }),

    value: Procedure.subscription({
      requestInit: Type.Object({}),
      responseData: Type.Object({ result: Type.Number() }),
      async handler({ ctx, resWriter }) {
        const dispose = ctx.state.count.observe((count) => {
          resWriter.write(Ok({ result: count }));
        });

        ctx.onRequestFinished(dispose);
      },
    }),
  },
);

export const UploadableServiceSchema = ServiceSchema.define({
  addMultiple: Procedure.upload({
    requestInit: Type.Object({}),
    requestData: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ result: Type.Number() }),
    async handler({ reqReader }) {
      let result = 0;
      for await (const input of reqReader) {
        result += unwrap(input).n;
      }

      return Ok({ result: result });
    },
  }),

  addMultipleWithPrefix: Procedure.upload({
    requestInit: Type.Object({ prefix: Type.String() }),
    requestData: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ result: Type.String() }),
    async handler({ reqInit, reqReader }) {
      let result = 0;
      for await (const input of reqReader) {
        result += unwrap(input).n;
      }
      return Ok({ result: `${reqInit.prefix} ${result}` });
    },
  }),
});

const RecursivePayload = Type.Recursive((This) =>
  Type.Object({
    n: Type.Number(),
    next: Type.Optional(This),
  }),
);

export const NonObjectSchemas = ServiceSchema.define({
  add: Procedure.rpc({
    requestInit: Type.Number(),
    responseData: Type.Number(),
    async handler({ reqInit }) {
      return Ok(reqInit + 1);
    },
  }),

  echoRecursive: Procedure.rpc({
    requestInit: RecursivePayload,
    responseData: RecursivePayload,
    async handler({ reqInit }) {
      return Ok(reqInit);
    },
  }),
});
