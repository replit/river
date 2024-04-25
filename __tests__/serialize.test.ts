import { expect, describe, test } from 'vitest';
import {
  BinaryFileServiceSchema,
  FallibleServiceSchema,
  TestServiceSchema,
} from './fixtures/services';

describe('serialize service to jsonschema', () => {
  test('serialize basic service', () => {
    expect(TestServiceSchema.serialize()).toStrictEqual({
      procedures: {
        add: {
          description: 'Adds two numbers and returns a value',
          input: {
            properties: {
              n: { description: 'A number', type: 'number' },
            },
            description: 'An input object',
            required: ['n'],
            type: 'object',
          },
          output: {
            properties: {
              result: { description: 'A number', type: 'number' },
            },
            description: 'An output object',
            required: ['result'],
            type: 'object',
          },
          errors: {
            not: {},
          },
          type: 'rpc',
        },
        echo: {
          description: 'Streams an echo back',
          input: {
            description: 'A request that echos',
            properties: {
              msg: { description: 'A string', type: 'string' },
              ignore: { description: 'A boolean', type: 'boolean' },
              end: { description: 'A boolean', type: 'boolean' },
            },
            required: ['msg', 'ignore'],
            type: 'object',
          },
          output: {
            description: 'A response from an echo',
            properties: {
              response: { description: 'A string', type: 'string' },
            },
            required: ['response'],
            type: 'object',
          },
          errors: {
            not: {},
          },
          type: 'stream',
        },
        echoWithPrefix: {
          description: 'Streams an echo back',
          errors: {
            not: {},
          },
          init: {
            description: 'An init object',
            properties: {
              prefix: {
                description: 'A prefix',
                type: 'string',
              },
            },
            required: ['prefix'],
            type: 'object',
          },
          input: {
            description: 'A request that echos',
            properties: {
              end: {
                description: 'A boolean',
                type: 'boolean',
              },
              ignore: {
                description: 'A boolean',
                type: 'boolean',
              },
              msg: {
                description: 'A string',
                type: 'string',
              },
            },
            required: ['msg', 'ignore'],
            type: 'object',
          },
          output: {
            description: 'A response from an echo',
            properties: {
              response: {
                description: 'A string',
                type: 'string',
              },
            },
            required: ['response'],
            type: 'object',
          },
          type: 'stream',
        },
        echoUnion: {
          description: 'Echos back whatever we sent',
          errors: {
            not: {},
          },
          input: {
            anyOf: [
              {
                description: 'A',
                properties: {
                  a: {
                    description: 'A number',
                    type: 'number',
                  },
                },
                required: ['a'],
                type: 'object',
              },
              {
                description: 'B',
                properties: {
                  b: {
                    description: 'A string',
                    type: 'string',
                  },
                },
                required: ['b'],
                type: 'object',
              },
            ],
          },
          output: {
            anyOf: [
              {
                description: 'A',
                properties: {
                  a: {
                    description: 'A number',
                    type: 'number',
                  },
                },
                required: ['a'],
                type: 'object',
              },
              {
                description: 'B',
                properties: {
                  b: {
                    description: 'A string',
                    type: 'string',
                  },
                },
                required: ['b'],
                type: 'object',
              },
            ],
          },
          type: 'rpc',
        },
      },
    });
  });

  test('serialize service with binary', () => {
    expect(BinaryFileServiceSchema.serialize()).toStrictEqual({
      procedures: {
        getFile: {
          description: 'Retrieves a file from a path',
          errors: {
            not: {},
          },
          input: {
            description: 'An input object',
            properties: {
              file: {
                description: 'A file path',
                type: 'string',
              },
            },
            required: ['file'],
            type: 'object',
          },
          output: {
            description: 'An output object',
            properties: {
              contents: {
                description: 'File contents',
                type: 'Uint8Array',
              },
            },
            required: ['contents'],
            type: 'object',
          },
          type: 'rpc',
        },
      },
    });
  });

  test('serialize service with errors', () => {
    expect(FallibleServiceSchema.serialize()).toStrictEqual({
      procedures: {
        divide: {
          description: 'Divide one number by another number',
          input: {
            description: 'An input object',
            properties: {
              a: { description: 'A number', type: 'number' },
              b: { description: 'A number', type: 'number' },
            },
            required: ['a', 'b'],
            type: 'object',
          },
          output: {
            description: 'An output object',
            properties: {
              result: { description: 'A result', type: 'number' },
            },
            required: ['result'],
            type: 'object',
          },
          errors: {
            description: 'An error object',
            properties: {
              code: {
                description: 'A literal',
                const: 'DIV_BY_ZERO',
                type: 'string',
              },
              message: { description: 'A message', type: 'string' },
              extras: {
                description: 'A set of extras',
                properties: {
                  test: {
                    description: 'A test string',
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
          description: 'Streams an echo back',
          errors: {
            description: 'An error',
            properties: {
              code: {
                const: 'STREAM_ERROR',
                description: 'A literal code',
                type: 'string',
              },
              message: { description: 'A message', type: 'string' },
            },
            required: ['code', 'message'],
            type: 'object',
          },
          input: {
            description: 'An input',
            properties: {
              msg: { description: 'The message', type: 'string' },
              throwError: { description: 'Throw on error', type: 'boolean' },
              throwResult: { description: 'Throw on result', type: 'boolean' },
            },
            required: ['msg', 'throwResult', 'throwError'],
            type: 'object',
          },
          output: {
            description: 'An output',
            properties: {
              response: { description: 'A response', type: 'string' },
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
