import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  test,
  vitest,
} from 'vitest';
import { createMockTransportNetwork } from '../testUtil/fixtures/mockTransport';
import {
  Err,
  Ok,
  Procedure,
  ServiceSchema,
  createClient,
  createServer,
} from '../router';
import { MAX_PAYLOAD_SIZE_EXCEEDED_CODE } from '../router/errors';
import { Type } from '@sinclair/typebox';
import { readNextResult } from '../testUtil';
import { MaxPayloadSizeExceeded } from '../transport/sessionStateMachine/common';

describe('client exceeded max payload size', () => {
  let mockTransportNetwork: ReturnType<typeof createMockTransportNetwork>;

  beforeEach(async () => {
    mockTransportNetwork = createMockTransportNetwork({
      client: { maxPayloadSizeBytes: 1024 },
    });
  });

  afterEach(async () => {
    await mockTransportNetwork.cleanup();
  });

  test('rpc init exceeds max payload size', async () => {
    const mockHandler = vitest.fn();
    const services = {
      service: ServiceSchema.define({
        echo: Procedure.rpc({
          requestInit: Type.String(),
          responseData: Type.String(),
          handler: mockHandler,
        }),
      }),
    };
    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const result = await client.service.echo.rpc('0'.repeat(1025));
    expect(result).toStrictEqual({
      ok: false,
      payload: {
        code: MAX_PAYLOAD_SIZE_EXCEEDED_CODE,
        message:
          'client: payload exceeded maximum payload size size=1241 max=1024',
      },
    });
    expect(mockHandler).not.toHaveBeenCalled();
  });

  test('stream message exceeds max payload size', async () => {
    let handlerCanceled: Promise<null> | undefined;
    const services = {
      service: ServiceSchema.define({
        echo: Procedure.stream({
          requestInit: Type.String(),
          requestData: Type.String(),
          responseData: Type.String(),
          responseError: Type.Object({
            code: Type.Literal('ERROR'),
            message: Type.String(),
          }),
          handler: async ({ ctx, reqInit, reqReadable, resWritable }) => {
            handlerCanceled = new Promise((resolve) => {
              ctx.signal.onabort = () => resolve(null);
            });

            resWritable.write(Ok(reqInit));
            for await (const msg of reqReadable) {
              if (msg.ok) {
                resWritable.write(Ok(msg.payload));
              } else {
                resWritable.write(
                  Err({
                    code: 'ERROR',
                    message: 'error reading from client',
                  }),
                );
                break;
              }
            }
          },
        }),
      }),
    };
    createServer(mockTransportNetwork.getServerTransport(), services);
    const transport = mockTransportNetwork.getClientTransport('client');
    const client = createClient<typeof services>(transport, 'SERVER');

    const stream = client.service.echo.stream('start');
    let result = await readNextResult(stream.resReadable);
    expect(result).toStrictEqual({ ok: true, payload: 'start' });

    let error;
    try {
      stream.reqWritable.write('0'.repeat(1025));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MaxPayloadSizeExceeded);

    result = await readNextResult(stream.resReadable);
    expect(result).toStrictEqual({
      ok: false,
      payload: {
        code: MAX_PAYLOAD_SIZE_EXCEEDED_CODE,
        message:
          'client: payload exceeded maximum payload size size=1148 max=1024',
      },
    });
    assert(handlerCanceled);
    await handlerCanceled;
  });
});

describe('server exceeded max payload size', () => {
  let mockTransportNetwork: ReturnType<typeof createMockTransportNetwork>;

  beforeEach(async () => {
    mockTransportNetwork = createMockTransportNetwork({
      server: { maxPayloadSizeBytes: 1024 },
    });
  });

  afterEach(async () => {
    await mockTransportNetwork.cleanup();
  });

  test('rpc response exceeds max payload size', async () => {
    const services = {
      service: ServiceSchema.define({
        echo: Procedure.rpc({
          requestInit: Type.String(),
          responseData: Type.String(),
          handler: async ({ reqInit }) => {
            return Ok(reqInit);
          },
        }),
      }),
    };
    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const result = await client.service.echo.rpc('0'.repeat(1025));
    expect(result).toStrictEqual({
      ok: false,
      payload: {
        code: MAX_PAYLOAD_SIZE_EXCEEDED_CODE,
        message:
          'server: payload exceeded maximum payload size size=1170 max=1024',
      },
    });
  });

  test('stream message exceeds max payload size', async () => {
    const services = {
      service: ServiceSchema.define({
        echo: Procedure.subscription({
          requestInit: Type.Object({}),
          responseData: Type.String(),
          handler: async ({ resWritable }) => {
            resWritable.write(Ok('0'.repeat(1025)));
          },
        }),
      }),
    };
    createServer(mockTransportNetwork.getServerTransport(), services);
    const client = createClient<typeof services>(
      mockTransportNetwork.getClientTransport('client'),
      'SERVER',
    );

    const stream = client.service.echo.subscribe({});
    const result = await readNextResult(stream.resReadable);
    expect(result).toStrictEqual({
      ok: false,
      payload: {
        code: MAX_PAYLOAD_SIZE_EXCEEDED_CODE,
        message:
          'server: payload exceeded maximum payload size size=1170 max=1024',
      },
    });
    expect(stream.resReadable.isReadable()).toEqual(false);
  });
});
