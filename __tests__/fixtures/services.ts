import { Type } from '@sinclair/typebox';
import { ServiceBuilder } from '../../router/builder';
import { Err, Ok } from '../../router/result';
import { Observable } from './observable';

export const EchoRequest = Type.Object({
  msg: Type.String(),
  ignore: Type.Boolean(),
  end: Type.Optional(Type.Boolean()),
});
export const EchoResponse = Type.Object({ response: Type.String() });

export const TestServiceConstructor = () =>
  ServiceBuilder.create('test')
    .initialState({
      count: 0,
    })
    .defineProcedure('add', {
      type: 'rpc',
      input: Type.Object({ n: Type.Number() }),
      output: Type.Object({ result: Type.Number() }),
      errors: Type.Never(),
      async handler(ctx, { n }) {
        ctx.state.count += n;
        return Ok({ result: ctx.state.count });
      },
    })
    .defineProcedure('echo', {
      type: 'stream',
      input: EchoRequest,
      output: EchoResponse,
      errors: Type.Never(),
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
    })
    .defineProcedure('echoWithPrefix', {
      type: 'stream',
      init: Type.Object({ prefix: Type.String() }),
      input: EchoRequest,
      output: EchoResponse,
      errors: Type.Never(),
      async handler(_ctx, init, msgStream, returnStream) {
        for await (const { ignore, msg } of msgStream) {
          if (!ignore) {
            returnStream.push(Ok({ response: `${init.prefix} ${msg}` }));
          }
        }
      },
    })
    .finalize();

export const OrderingServiceConstructor = () =>
  ServiceBuilder.create('test')
    .initialState({
      msgs: [] as number[],
    })
    .defineProcedure('add', {
      type: 'rpc',
      input: Type.Object({ n: Type.Number() }),
      output: Type.Object({ n: Type.Number() }),
      errors: Type.Never(),
      async handler(ctx, { n }) {
        ctx.state.msgs.push(n);
        return Ok({ n });
      },
    })
    .defineProcedure('getAll', {
      type: 'rpc',
      input: Type.Object({}),
      output: Type.Object({ msgs: Type.Array(Type.Number()) }),
      errors: Type.Never(),
      async handler(ctx, _msg) {
        return Ok({ msgs: ctx.state.msgs });
      },
    })
    .finalize();

export const BinaryFileServiceConstructor = () =>
  ServiceBuilder.create('bin')
    .defineProcedure('getFile', {
      type: 'rpc',
      input: Type.Object({ file: Type.String() }),
      output: Type.Object({ contents: Type.Uint8Array() }),
      errors: Type.Never(),
      async handler(_ctx, { file }) {
        const bytes: Uint8Array = new TextEncoder().encode(
          `contents for file ${file}`,
        );
        return Ok({ contents: bytes });
      },
    })
    .finalize();

export const DIV_BY_ZERO = 'DIV_BY_ZERO';
export const STREAM_ERROR = 'STREAM_ERROR';
export const FallibleServiceConstructor = () =>
  ServiceBuilder.create('fallible')
    .initialState({})
    .defineProcedure('divide', {
      type: 'rpc',
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
    })
    .defineProcedure('echo', {
      type: 'stream',
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
    })
    .finalize();

export const SubscribableServiceConstructor = () =>
  ServiceBuilder.create('subscribable')
    .initialState({
      count: new Observable<number>(0),
    })
    .defineProcedure('add', {
      type: 'rpc',
      input: Type.Object({ n: Type.Number() }),
      output: Type.Object({ result: Type.Number() }),
      errors: Type.Never(),
      async handler(ctx, { n }) {
        ctx.state.count.set((prev) => prev + n);
        return Ok({ result: ctx.state.count.get() });
      },
    })
    .defineProcedure('value', {
      type: 'subscription',
      input: Type.Object({}),
      output: Type.Object({ result: Type.Number() }),
      errors: Type.Never(),
      async handler(ctx, _msg, returnStream) {
        ctx.state.count.observe((count) => {
          returnStream.push(Ok({ result: count }));
        });
      },
    })
    .finalize();

export const UploadableServiceConstructor = () =>
  ServiceBuilder.create('uploadable')
    .initialState({})
    .defineProcedure('addMultiple', {
      type: 'upload',
      input: Type.Object({ n: Type.Number() }),
      output: Type.Object({ result: Type.Number() }),
      errors: Type.Never(),
      async handler(_ctx, msgStream) {
        let result = 0;
        for await (const { n } of msgStream) {
          result += n;
        }

        return Ok({ result: result });
      },
    })
    .defineProcedure('addMultipleWithPrefix', {
      type: 'upload',
      init: Type.Object({ prefix: Type.String() }),
      input: Type.Object({ n: Type.Number() }),
      output: Type.Object({ result: Type.String() }),
      errors: Type.Never(),
      async handler(_ctx, init, msgStream) {
        let result = 0;
        for await (const { n } of msgStream) {
          result += n;
        }
        return Ok({ result: init.prefix + ' ' + result });
      },
    })
    .finalize();
