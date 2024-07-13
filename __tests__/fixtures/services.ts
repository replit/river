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
    init: Type.Object({ n: Type.Number() }),
    output: Type.Object({ result: Type.Number() }),
    async handler(ctx, { n }) {
      ctx.state.count += n;
      return Ok({ result: ctx.state.count });
    },
  }),

  array: Procedure.rpc({
    init: Type.Object({ n: Type.Number() }),
    output: Type.Array(Type.Number()),
    async handler(ctx, { n }) {
      ctx.state.count += n;
      return Ok([ctx.state.count]);
    },
  }),

  arrayStream: Procedure.stream({
    init: Type.Object({}),
    input: Type.Object({ n: Type.Number() }),
    output: Type.Array(Type.Number()),
    async handler(_, _init, inputStream, returnStream) {
      for await (const msg of inputStream) {
        returnStream.write(Ok([unwrap(msg).n]));
      }
    },
  }),

  echo: Procedure.stream({
    init: Type.Object({}),
    input: EchoRequest,
    output: EchoResponse,
    async handler(_ctx, _init, inputStream, returnStream) {
      returnStream.onCloseRequest(() => {
        returnStream.close();
      });

      for await (const input of inputStream) {
        const { ignore, msg } = unwrap(input);
        if (!ignore) {
          returnStream.write(Ok({ response: msg }));
        }
      }
      returnStream.close();
    },
  }),

  echoWithPrefix: Procedure.stream({
    init: Type.Object({ prefix: Type.String() }),
    input: EchoRequest,
    output: EchoResponse,
    async handler(_ctx, init, inputStream, returnStream) {
      returnStream.onCloseRequest(() => {
        returnStream.close();
      });

      for await (const input of inputStream) {
        const { ignore, msg } = unwrap(input);
        if (!ignore) {
          returnStream.write(Ok({ response: `${init.prefix} ${msg}` }));
        }
      }
    },
  }),

  echoUnion: Procedure.rpc({
    description: 'Echos back whatever we sent',
    init: Type.Union([
      Type.Object(
        { a: Type.Number({ description: 'A number' }) },
        { description: 'A' },
      ),
      Type.Object(
        { b: Type.String({ description: 'A string' }) },
        { description: 'B' },
      ),
    ]),
    output: Type.Union([
      Type.Object(
        { a: Type.Number({ description: 'A number' }) },
        { description: 'A' },
      ),
      Type.Object(
        { b: Type.String({ description: 'A string' }) },
        { description: 'B' },
      ),
    ]),
    async handler(_, input) {
      return Ok(input);
    },
  }),

  unimplementedUpload: Procedure.upload({
    init: Type.Object({}),
    input: Type.Object({}),
    output: Type.Object({}),
    async handler() {
      throw new Error('Not implemented');
    },
  }),

  unimplementedSubscription: Procedure.subscription({
    init: Type.Object({}),
    output: Type.Object({}),
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
      init: Type.Object({ n: Type.Number() }),
      output: Type.Object({ n: Type.Number() }),
      async handler(ctx, { n }) {
        ctx.state.msgs.push(n);
        return Ok({ n });
      },
    }),

    getAll: Procedure.rpc({
      init: Type.Object({}),
      output: Type.Object({ msgs: Type.Array(Type.Number()) }),
      async handler(ctx, _msg) {
        return Ok({ msgs: ctx.state.msgs });
      },
    }),
  },
);

export const BinaryFileServiceSchema = ServiceSchema.define({
  getFile: Procedure.rpc({
    init: Type.Object({ file: Type.String() }),
    output: Type.Object({ contents: Type.Uint8Array() }),
    async handler(_ctx, { file }) {
      const bytes: Uint8Array = Buffer.from(`contents for file ${file}`);
      return Ok({ contents: bytes });
    },
  }),
});

export const DIV_BY_ZERO = 'DIV_BY_ZERO';
export const STREAM_ERROR = 'STREAM_ERROR';

export const FallibleServiceSchema = ServiceSchema.define({
  divide: Procedure.rpc({
    init: Type.Object({ a: Type.Number(), b: Type.Number() }),
    output: Type.Object({ result: Type.Number() }),
    errors: Type.Union([
      Type.Object({
        code: Type.Literal(DIV_BY_ZERO),
        message: Type.String(),
        extras: Type.Object({ test: Type.String() }),
      }),
    ]),
    async handler(_ctx, { a, b }) {
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
    init: Type.Object({}),
    input: Type.Object({
      msg: Type.String(),
      throwResult: Type.Boolean(),
      throwError: Type.Boolean(),
    }),
    output: Type.Object({ response: Type.String() }),
    errors: Type.Object({
      code: Type.Literal(STREAM_ERROR),
      message: Type.String(),
    }),
    async handler(_ctx, _init, inputStream, outputStream) {
      for await (const input of inputStream) {
        const { msg, throwError, throwResult } = unwrap(input);
        if (throwError) {
          throw new Error('some message');
        } else if (throwResult) {
          outputStream.write(
            Err({
              code: STREAM_ERROR,
              message: 'field throwResult was set to true',
            }),
          );
        } else {
          outputStream.write(Ok({ response: msg }));
        }
      }
    },
  }),
});

export const SubscribableServiceSchema = ServiceSchema.define(
  { initializeState: () => ({ count: new Observable(0) }) },
  {
    add: Procedure.rpc({
      init: Type.Object({ n: Type.Number() }),
      output: Type.Object({ result: Type.Number() }),
      async handler(ctx, { n }) {
        ctx.state.count.set((prev) => prev + n);
        return Ok({ result: ctx.state.count.get() });
      },
    }),

    value: Procedure.subscription({
      init: Type.Object({}),
      output: Type.Object({ result: Type.Number() }),
      async handler(ctx, _msg, returnStream) {
        const dispose1 = ctx.state.count.observe((count) => {
          returnStream.write(Ok({ result: count }));
        });

        ctx.onRequestFinished(dispose1);

        const dispose2 = returnStream.onCloseRequest(() => {
          returnStream.close();
        });

        ctx.onRequestFinished(dispose2);
      },
    }),
  },
);

export const UploadableServiceSchema = ServiceSchema.define({
  addMultiple: Procedure.upload({
    init: Type.Object({}),
    input: Type.Object({ n: Type.Number() }),
    output: Type.Object({ result: Type.Number() }),
    async handler(_ctx, _init, inputStream) {
      let result = 0;
      for await (const input of inputStream) {
        result += unwrap(input).n;
      }

      return Ok({ result: result });
    },
  }),

  addMultipleWithPrefix: Procedure.upload({
    init: Type.Object({ prefix: Type.String() }),
    input: Type.Object({ n: Type.Number() }),
    output: Type.Object({ result: Type.String() }),
    async handler(_ctx, init, inputStream) {
      let result = 0;
      for await (const input of inputStream) {
        result += unwrap(input).n;
      }
      return Ok({ result: `${init.prefix} ${result}` });
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
    init: Type.Number(),
    output: Type.Number(),
    async handler(_ctx, n) {
      return Ok(n + 1);
    },
  }),

  echoRecursive: Procedure.rpc({
    init: RecursivePayload,
    output: RecursivePayload,
    async handler(_ctx, msg) {
      return Ok(msg);
    },
  }),
});
