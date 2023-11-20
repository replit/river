import { Type } from '@sinclair/typebox';
import { ServiceBuilder } from '../router/builder';
import { reply } from '../transport/message';
import { Err, Ok } from '../router/result';

export const EchoRequest = Type.Object({
  msg: Type.String(),
  ignore: Type.Boolean(),
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
      async handler(ctx, msg) {
        const { n } = msg.payload;
        ctx.state.count += n;
        return reply(msg, Ok({ result: ctx.state.count }));
      },
    })
    .defineProcedure('echo', {
      type: 'stream',
      input: EchoRequest,
      output: EchoResponse,
      errors: Type.Never(),
      async handler(_ctx, msgStream, returnStream) {
        for await (const msg of msgStream) {
          const req = msg.payload;
          if (!req.ignore) {
            returnStream.push(reply(msg, Ok({ response: req.msg })));
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
      async handler(ctx, msg) {
        const { n } = msg.payload;
        ctx.state.msgs.push(n);
        return reply(msg, Ok({ n }));
      },
    })
    .defineProcedure('getAll', {
      type: 'rpc',
      input: Type.Object({}),
      output: Type.Object({ msgs: Type.Array(Type.Number()) }),
      errors: Type.Never(),
      async handler(ctx, msg) {
        return reply(msg, Ok({ msgs: ctx.state.msgs }));
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
      async handler(_ctx, msg) {
        const { a, b } = msg.payload;
        if (b === 0) {
          return reply(msg, {
            ok: false,
            payload: {
              code: DIV_BY_ZERO,
              message: 'Cannot divide by zero',
              extras: { test: 'abc' },
            },
          });
        } else {
          return reply(msg, Ok({ result: a / b }));
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
      errors: Type.Union([
        Type.Object({
          code: Type.Literal(STREAM_ERROR),
          message: Type.String(),
        }),
      ]),
      async handler(_ctx, msgStream, returnStream) {
        for await (const msg of msgStream) {
          const req = msg.payload;
          if (req.throwError) {
            throw new Error('some message');
          } else if (req.throwResult) {
            returnStream.push(
              reply(
                msg,
                Err({
                  code: STREAM_ERROR,
                  message: 'field throwResult was set to true',
                }),
              ),
            );
          } else {
            returnStream.push(reply(msg, Ok({ response: req.msg })));
          }
        }
      },
    })
    .finalize();
