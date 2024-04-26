import { Type } from '@sinclair/typebox';
import { ServiceSchema } from '../../router/services';
import { Err, Ok } from '../../router/result';
import { Observable } from './observable';
import { Procedure } from '../../router';

export const EchoRequest = Type.Object({
  msg: Type.String(),
  ignore: Type.Boolean(),
  end: Type.Optional(Type.Boolean()),
});
export const EchoResponse = Type.Object({ response: Type.String() });

const TestServiceScaffold = ServiceSchema.scaffold({
  initializeState: () => ({ count: 0 }),
});

const testServiceProcedures = TestServiceScaffold.procedures({
  add: Procedure.rpc({
    input: Type.Object({ n: Type.Number() }),
    output: Type.Object({ result: Type.Number() }),
    async handler(ctx, { n }) {
      ctx.state.count += n;
      return Ok({ result: ctx.state.count });
    },
  }),

  echo: Procedure.stream({
    input: EchoRequest,
    output: EchoResponse,
    async handler(_ctx, msgStream, returnStream) {
      for await (const { ignore, msg, end } of msgStream) {
        if (!ignore) {
          returnStream.push(Ok({ response: msg }));
        }

        if (end) {
          returnStream.end();
        }
      }
    },
  }),

  echoWithPrefix: Procedure.stream({
    init: Type.Object({ prefix: Type.String() }),
    input: EchoRequest,
    output: EchoResponse,
    async handler(_ctx, init, msgStream, returnStream) {
      for await (const { ignore, msg } of msgStream) {
        if (!ignore) {
          returnStream.push(Ok({ response: `${init.prefix} ${msg}` }));
        }
      }
    },
  }),

  echoUnion: Procedure.rpc({
    description: 'Echos back whatever we sent',
    input: Type.Union([
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
});

export const TestServiceSchema = TestServiceScaffold.finalize({
  ...testServiceProcedures,
});

export const OrderingServiceSchema = ServiceSchema.define(
  { initializeState: () => ({ msgs: [] as Array<number> }) },
  {
    add: Procedure.rpc({
      input: Type.Object({ n: Type.Number() }),
      output: Type.Object({ n: Type.Number() }),
      async handler(ctx, { n }) {
        ctx.state.msgs.push(n);
        return Ok({ n });
      },
    }),

    getAll: Procedure.rpc({
      input: Type.Object({}),
      output: Type.Object({ msgs: Type.Array(Type.Number()) }),
      async handler(ctx, _msg) {
        return Ok({ msgs: ctx.state.msgs });
      },
    }),
  },
);

export const BinaryFileServiceSchema = ServiceSchema.define({
  getFile: Procedure.rpc({
    input: Type.Object({ file: Type.String() }),
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
    input: Type.Object({ a: Type.Number(), b: Type.Number() }),
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
    async handler(_ctx, msgStream, returnStream) {
      for await (const { msg, throwError, throwResult } of msgStream) {
        if (throwError) {
          throw new Error('some message');
        } else if (throwResult) {
          returnStream.push(
            Err({
              code: STREAM_ERROR,
              message: 'field throwResult was set to true',
            }),
          );
        } else {
          returnStream.push(Ok({ response: msg }));
        }
      }
    },
  }),
});

export const SubscribableServiceSchema = ServiceSchema.define(
  { initializeState: () => ({ count: new Observable(0) }) },
  {
    add: Procedure.rpc({
      input: Type.Object({ n: Type.Number() }),
      output: Type.Object({ result: Type.Number() }),
      async handler(ctx, { n }) {
        ctx.state.count.set((prev) => prev + n);
        return Ok({ result: ctx.state.count.get() });
      },
    }),

    value: Procedure.subscription({
      input: Type.Object({}),
      output: Type.Object({ result: Type.Number() }),
      async handler(ctx, _msg, returnStream) {
        return ctx.state.count.observe((count) => {
          returnStream.push(Ok({ result: count }));
        });
      },
    }),
  },
);

export const UploadableServiceSchema = ServiceSchema.define({
  addMultiple: Procedure.upload({
    input: Type.Object({ n: Type.Number() }),
    output: Type.Object({ result: Type.Number() }),
    async handler(_ctx, msgStream) {
      let result = 0;
      for await (const { n } of msgStream) {
        result += n;
      }

      return Ok({ result: result });
    },
  }),

  addMultipleWithPrefix: Procedure.upload({
    init: Type.Object({ prefix: Type.String() }),
    input: Type.Object({ n: Type.Number() }),
    output: Type.Object({ result: Type.String() }),
    async handler(_ctx, init, msgStream) {
      let result = 0;
      for await (const { n } of msgStream) {
        result += n;
      }
      return Ok({ result: init.prefix + ' ' + result });
    },
  }),
});
