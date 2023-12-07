import { expect, describe, test } from 'vitest';
import { serializeService } from '../router/builder';
import {
  BinaryFileServiceConstructor,
  FallibleServiceConstructor,
  TestServiceConstructor,
} from './fixtures/services';

describe('serialize service to jsonschema', () => {
  test('serialize basic service', () => {
    const service = TestServiceConstructor();
    expect(serializeService(service)).toStrictEqual({
      name: 'test',
      state: { count: 0 },
      procedures: {
        add: {
          input: {
            properties: {
              n: { type: 'number' },
            },
            required: ['n'],
            type: 'object',
          },
          output: {
            properties: {
              result: { type: 'number' },
            },
            required: ['result'],
            type: 'object',
          },
          errors: { not: {} },
          type: 'rpc',
        },
        echo: {
          input: {
            properties: {
              msg: { type: 'string' },
              ignore: { type: 'boolean' },
            },
            required: ['msg', 'ignore'],
            type: 'object',
          },
          output: {
            properties: {
              response: { type: 'string' },
            },
            required: ['response'],
            type: 'object',
          },
          errors: { not: {} },
          type: 'stream',
        },
      },
    });
  });

  test('serialize service with binary', () => {
    const service = BinaryFileServiceConstructor();
    expect(serializeService(service)).toStrictEqual({
      name: 'bin',
      procedures: {
        getFile: {
          errors: {
            not: {},
          },
          input: {
            properties: {
              file: {
                type: 'string',
              },
            },
            required: ['file'],
            type: 'object',
          },
          output: {
            properties: {
              contents: {
                type: 'Uint8Array',
              },
            },
            required: ['contents'],
            type: 'object',
          },
          type: 'rpc',
        },
      },
      state: {},
    });
  });

  test('serialize service with errors', () => {
    const service = FallibleServiceConstructor();
    expect(serializeService(service)).toStrictEqual({
      name: 'fallible',
      state: {},
      procedures: {
        divide: {
          input: {
            properties: {
              a: { type: 'number' },
              b: { type: 'number' },
            },
            required: ['a', 'b'],
            type: 'object',
          },
          output: {
            properties: {
              result: { type: 'number' },
            },
            required: ['result'],
            type: 'object',
          },
          errors: {
            properties: {
              code: { const: 'DIV_BY_ZERO', type: 'string' },
              message: { type: 'string' },
              extras: {
                properties: {
                  test: {
                    type: 'string',
                  },
                },
                required: ['test'],
                type: 'object',
              },
            },
            required: ['code', 'message', 'extras'],
            type: 'object',
          },
          type: 'rpc',
        },
        echo: {
          errors: {
            properties: {
              code: {
                const: 'STREAM_ERROR',
                type: 'string',
              },
              message: {
                type: 'string',
              },
            },
            required: ['code', 'message'],
            type: 'object',
          },
          input: {
            properties: {
              msg: {
                type: 'string',
              },
              throwError: {
                type: 'boolean',
              },
              throwResult: {
                type: 'boolean',
              },
            },
            required: ['msg', 'throwResult', 'throwError'],
            type: 'object',
          },
          output: {
            properties: {
              response: {
                type: 'string',
              },
            },
            required: ['response'],
            type: 'object',
          },
          type: 'stream',
        },
      },
    });
  });
});
