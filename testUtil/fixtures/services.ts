import { Type } from '@sinclair/typebox';
import { createServiceSchema } from '../../router/services';
import { Err, Ok, unwrapOrThrow } from '../../router/result';
import { Observable } from '../observable/observable';
import { Procedure } from '../../router';

const ServiceSchema = createServiceSchema();

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
    async handler({ reqReadable, resWritable }) {
      for await (const msg of reqReadable) {
        resWritable.write(Ok([unwrapOrThrow(msg).n]));
      }
    },
  }),

  echo: Procedure.stream({
    requestInit: Type.Object({}),
    requestData: EchoRequest,
    responseData: EchoResponse,
    async handler({ reqReadable, resWritable }) {
      for await (const req of reqReadable) {
        const { ignore, msg } = unwrapOrThrow(req);
        if (!ignore) {
          resWritable.write(Ok({ response: msg }));
        }
      }

      resWritable.close();
    },
  }),

  echoWithPrefix: Procedure.stream({
    requestInit: Type.Object({ prefix: Type.String() }),
    requestData: EchoRequest,
    responseData: EchoResponse,
    async handler({ reqInit, reqReadable, resWritable }) {
      for await (const req of reqReadable) {
        const { ignore, msg } = unwrapOrThrow(req);
        if (!ignore) {
          resWritable.write(Ok({ response: `${reqInit.prefix} ${msg}` }));
        }
      }

      resWritable.close();
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

export const testContext = {
  logger: {
    info: (message: string) => {
      console.log(message);
    },
  },
  add: (a: number, b: number) => a + b,
};

const TestServiceWithContextScaffold = createServiceSchema<
  typeof testContext
>().scaffold({
  initializeState: () => ({ count: 0 }),
});

const testServiceWithContextProcedures =
  TestServiceWithContextScaffold.procedures({
    add: Procedure.rpc({
      requestInit: Type.Object({ n: Type.Number() }),
      responseData: Type.Object({ result: Type.Number() }),
      async handler({ ctx, reqInit: { n } }) {
        ctx.state.count += n;

        return Ok({ result: ctx.state.count });
      },
    }),
  });

export const TestServiceWithContextSchema =
  TestServiceWithContextScaffold.finalize({
    ...testServiceWithContextProcedures,
  });

export const OrderingServiceSchema = ServiceSchema.define(
  {
    initializeState: () => ({ msgs: [] as Array<number> }),
  },
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
      Type.Union([
        Type.Object({
          code: Type.Literal('INFINITY'),
          message: Type.String(),
        }),
      ]),
    ]),
    async handler({ reqInit: { a, b } }) {
      if (b === 0) {
        return Err({
          code: DIV_BY_ZERO,
          message: 'Cannot divide by zero',
          extras: { test: 'abc' },
        });
      } else if (a === Infinity || b === Infinity) {
        return Err({
          code: 'INFINITY',
          message: 'Result is infinity',
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
    async handler({ reqReadable, resWritable }) {
      for await (const req of reqReadable) {
        const { msg, throwError, throwResult } = unwrapOrThrow(req);
        if (throwError) {
          throw new Error('some message');
        } else if (throwResult) {
          resWritable.write(
            Err({
              code: STREAM_ERROR,
              message: 'field throwResult was set to true',
            }),
          );
        } else {
          resWritable.write(Ok({ response: msg }));
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
      async handler({ ctx, resWritable }) {
        const dispose = ctx.state.count.observe((count) => {
          resWritable.write(Ok({ result: count }));
        });

        ctx.signal.addEventListener('abort', () => dispose());
      },
    }),
  },
);

export const UploadableServiceSchema = ServiceSchema.define({
  addMultiple: Procedure.upload({
    requestInit: Type.Object({}),
    requestData: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ result: Type.Number() }),
    async handler({ reqReadable }) {
      let result = 0;
      for await (const req of reqReadable) {
        result += unwrapOrThrow(req).n;
      }

      return Ok({ result: result });
    },
  }),

  addMultipleWithPrefix: Procedure.upload({
    requestInit: Type.Object({ prefix: Type.String() }),
    requestData: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ result: Type.String() }),
    async handler({ reqInit, reqReadable }) {
      let result = 0;
      for await (const req of reqReadable) {
        result += unwrapOrThrow(req).n;
      }

      return Ok({ result: `${reqInit.prefix} ${result}` });
    },
  }),

  cancellableAdd: Procedure.upload({
    requestInit: Type.Object({}),
    requestData: Type.Object({ n: Type.Number() }),
    responseData: Type.Object({ result: Type.Number() }),
    async handler({ ctx, reqReadable }) {
      let result = 0;
      for await (const req of reqReadable) {
        const n = unwrapOrThrow(req).n;
        if (result + n >= 10) {
          return ctx.cancel("can't add more than 10");
        }

        result += n;
      }

      return Ok({ result: result });
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

export function SchemaWithDisposableState(dispose: () => void) {
  return ServiceSchema.define(
    { initializeState: () => ({ [Symbol.dispose]: dispose }) },
    {
      add: Procedure.rpc({
        requestInit: Type.Number(),
        responseData: Type.Number(),
        async handler({ reqInit }) {
          return Ok(reqInit + 1);
        },
      }),
    },
  );
}

export function SchemaWithAsyncDisposableStateAndScaffold(
  dispose: () => Promise<void>,
) {
  const scaffold = ServiceSchema.scaffold({
    initializeState: () => ({ [Symbol.asyncDispose]: dispose }),
  });

  const procs = scaffold.procedures({
    add: Procedure.rpc({
      requestInit: Type.Number(),
      responseData: Type.Number(),
      async handler({ reqInit }) {
        return Ok(reqInit + 1);
      },
    }),
  });

  return scaffold.finalize(procs);
}
