import { Type } from '../../types';
import { ServiceSchema } from '../../router/services';
import { Err, Ok } from '../../router/result';
import { Observable } from './observable';
import { Procedure } from '../../router';

export const EchoRequest = Type.Object(
  {
    msg: Type.String({ description: 'A string' }),
    ignore: Type.Boolean({ description: 'A boolean' }),
    end: Type.Optional(Type.Boolean({ description: 'A boolean' })),
  },
  { description: 'A request that echos' },
);
export const EchoResponse = Type.Object(
  { response: Type.String({ description: 'A string' }) },
  { description: 'A response from an echo' },
);

const TestServiceScaffold = ServiceSchema.scaffold({
  initializeState: () => ({ count: 0 }),
});

const testServiceProcedures = TestServiceScaffold.procedures({
  add: Procedure.rpc({
    description: 'Adds two numbers and returns a value',
    input: Type.Object(
      { n: Type.Number({ description: 'A number' }) },
      { description: 'An input object' },
    ),
    output: Type.Object(
      { result: Type.Number({ description: 'A number' }) },
      { description: 'An output object' },
    ),
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
    init: Type.Object(
      { prefix: Type.String({ description: 'A prefix' }) },
      { description: 'An init object' },
    ),
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
});

export const TestServiceSchema = TestServiceScaffold.finalize({
  ...testServiceProcedures,
});

export const OrderingServiceSchema = ServiceSchema.define(
  { initializeState: () => ({ msgs: [] as Array<number> }) },
  {
    add: Procedure.rpc({
      description: 'Adds two numbers and returns a value',
      input: Type.Object(
        { n: Type.Number({ description: 'A number' }) },
        { description: 'An input' },
      ),
      output: Type.Object(
        { n: Type.Number({ description: 'A number' }) },
        { description: 'An output' },
      ),
      async handler(ctx, { n }) {
        ctx.state.msgs.push(n);
        return Ok({ n });
      },
    }),

    getAll: Procedure.rpc({
      description: 'Retrieves all messages',
      input: Type.Object({}, { description: 'An input object' }),
      output: Type.Object(
        {
          msgs: Type.Array(Type.Number({ description: 'A number' }), {
            description: 'A set of messages',
          }),
        },
        { description: 'An output object' },
      ),
      async handler(ctx, _msg) {
        return Ok({ msgs: ctx.state.msgs });
      },
    }),
  },
);

export const BinaryFileServiceSchema = ServiceSchema.define({
  getFile: Procedure.rpc({
    description: 'Retrieves a file from a path',
    input: Type.Object(
      { file: Type.String({ description: 'A file path' }) },
      { description: 'An input object' },
    ),
    output: Type.Object(
      { contents: Type.Uint8Array({ description: 'File contents' }) },
      { description: 'An output object' },
    ),
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
    /* description: Get the probability of rain for a specific location */
    input: Type.Object(
      {
        a: Type.Number({ description: 'A number' }),
        b: Type.Number({ description: 'A number' }),
      },
      { description: 'An input object' },
    ),
    output: Type.Object(
      { result: Type.Number({ description: 'A result' }) },
      { description: 'An output object' },
    ),
    errors: Type.Union([
      Type.Object(
        {
          code: Type.Literal(DIV_BY_ZERO, { description: 'A literal' }),
          message: Type.String({ description: 'A message' }),
          extras: Type.Object(
            { test: Type.String({ description: 'A test string' }) },
            { description: 'A set of extras' },
          ),
        },
        { description: 'An error object' },
      ),
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
    input: Type.Object(
      {
        msg: Type.String({ description: 'The message' }),
        throwResult: Type.Boolean({ description: 'Throw on result' }),
        throwError: Type.Boolean({ description: 'Throw on error' }),
      },
      { description: 'An input' },
    ),
    output: Type.Object(
      { response: Type.String({ description: 'A response' }) },
      { description: 'An output' },
    ),
    errors: Type.Object(
      {
        code: Type.Literal(STREAM_ERROR, { description: 'A literal code' }),
        message: Type.String({ description: 'A message' }),
      },
      { description: 'An error' },
    ),
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
      description: 'Adds two numbers and returns a value',
      input: Type.Object(
        { n: Type.Number({ description: 'A number' }) },
        { description: 'An input object' },
      ),
      output: Type.Object(
        { result: Type.Number({ description: 'A result' }) },
        { description: 'An output object' },
      ),
      async handler(ctx, { n }) {
        ctx.state.count.set((prev) => prev + n);
        return Ok({ result: ctx.state.count.get() });
      },
    }),

    value: Procedure.subscription({
      input: Type.Object({}, { description: 'An input object' }),
      output: Type.Object(
        { result: Type.Number({ description: 'A result' }) },
        { description: 'An output object' },
      ),
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
    input: Type.Object(
      { n: Type.Number({ description: 'A number' }) },
      { description: 'An input object' },
    ),
    output: Type.Object(
      { result: Type.Number({ description: 'A result' }) },
      { description: 'An output object' },
    ),
    async handler(_ctx, msgStream) {
      let result = 0;
      for await (const { n } of msgStream) {
        result += n;
      }

      return Ok({ result: result });
    },
  }),

  addMultipleWithPrefix: Procedure.upload({
    description: 'Adds multiple numbers',
    init: Type.Object(
      { prefix: Type.String({ description: 'A prefix' }) },
      { description: 'An initialization object' },
    ),
    input: Type.Object(
      { n: Type.Number({ description: 'A number' }) },
      { description: 'An input object' },
    ),
    output: Type.Object(
      { result: Type.String({ description: 'A result' }) },
      { description: 'An output object' },
    ),
    async handler(_ctx, init, msgStream) {
      let result = 0;
      for await (const { n } of msgStream) {
        result += n;
      }
      return Ok({ result: init.prefix + ' ' + result });
    },
  }),
});
