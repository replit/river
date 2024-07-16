import { expect, describe, test } from 'vitest';
import {
  BinaryFileServiceSchema,
  FallibleServiceSchema,
  TestServiceSchema,
} from './fixtures/services';
import { serializeSchema } from '../router';
import { Type } from '@sinclair/typebox';

describe('serialize server to jsonschema', () => {
  test('serialize entire service schema', () => {
    const schema = { test: TestServiceSchema };
    const handshakeSchema = Type.Object({
      token: Type.String(),
    });

    expect(serializeSchema(schema, handshakeSchema)).toStrictEqual({
      handshakeSchema: {
        properties: {
          token: { type: 'string' },
        },
        required: ['token'],
        type: 'object',
      },
      services: {
        test: {
          procedures: {
            add: {
              init: {
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
              errors: {
                not: {},
              },
              type: 'rpc',
            },
            array: {
              errors: {
                not: {},
              },
              init: {
                properties: {
                  n: {
                    type: 'number',
                  },
                },
                required: ['n'],
                type: 'object',
              },
              output: {
                items: {
                  type: 'number',
                },
                type: 'array',
              },
              type: 'rpc',
            },
            arrayStream: {
              errors: {
                not: {},
              },
              init: {
                properties: {},
                type: 'object',
              },
              input: {
                properties: {
                  n: {
                    type: 'number',
                  },
                },
                required: ['n'],
                type: 'object',
              },
              output: {
                items: {
                  type: 'number',
                },
                type: 'array',
              },
              type: 'stream',
            },
            echo: {
              init: {
                properties: {},
                type: 'object',
              },
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
              errors: {
                not: {},
              },
              type: 'stream',
            },
            echoWithPrefix: {
              errors: {
                not: {},
              },
              init: {
                properties: {
                  prefix: {
                    type: 'string',
                  },
                },
                required: ['prefix'],
                type: 'object',
              },
              input: {
                properties: {
                  ignore: {
                    type: 'boolean',
                  },
                  msg: {
                    type: 'string',
                  },
                },
                required: ['msg', 'ignore'],
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
            echoUnion: {
              description: 'Echos back whatever we sent',
              errors: {
                not: {},
              },
              init: {
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
            unimplementedSubscription: {
              errors: {
                not: {},
              },
              init: {
                properties: {},
                type: 'object',
              },
              output: {
                properties: {},
                type: 'object',
              },
              type: 'subscription',
            },
            unimplementedUpload: {
              errors: {
                not: {},
              },
              init: {
                properties: {},
                type: 'object',
              },
              input: {
                properties: {},
                type: 'object',
              },
              output: {
                properties: {},
                type: 'object',
              },
              type: 'upload',
            },
          },
        },
      },
    });
  });
});

describe('serialize service to jsonschema', () => {
  test('serialize basic service', () => {
    expect(TestServiceSchema.serialize()).toStrictEqual({
      procedures: {
        add: {
          init: {
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
          errors: {
            not: {},
          },
          type: 'rpc',
        },
        array: {
          errors: {
            not: {},
          },
          init: {
            properties: {
              n: {
                type: 'number',
              },
            },
            required: ['n'],
            type: 'object',
          },
          output: {
            items: {
              type: 'number',
            },
            type: 'array',
          },
          type: 'rpc',
        },
        arrayStream: {
          errors: {
            not: {},
          },
          init: {
            properties: {},
            type: 'object',
          },
          input: {
            properties: {
              n: {
                type: 'number',
              },
            },
            required: ['n'],
            type: 'object',
          },
          output: {
            items: {
              type: 'number',
            },
            type: 'array',
          },
          type: 'stream',
        },
        echo: {
          init: {
            properties: {},
            type: 'object',
          },
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
          errors: {
            not: {},
          },
          type: 'stream',
        },
        echoWithPrefix: {
          errors: {
            not: {},
          },
          init: {
            properties: {
              prefix: {
                type: 'string',
              },
            },
            required: ['prefix'],
            type: 'object',
          },
          input: {
            properties: {
              ignore: {
                type: 'boolean',
              },
              msg: {
                type: 'string',
              },
            },
            required: ['msg', 'ignore'],
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
        echoUnion: {
          description: 'Echos back whatever we sent',
          errors: {
            not: {},
          },
          init: {
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
        unimplementedSubscription: {
          errors: {
            not: {},
          },
          init: {
            properties: {},
            type: 'object',
          },
          output: {
            properties: {},
            type: 'object',
          },
          type: 'subscription',
        },
        unimplementedUpload: {
          errors: {
            not: {},
          },
          init: {
            properties: {},
            type: 'object',
          },
          input: {
            properties: {},
            type: 'object',
          },
          output: {
            properties: {},
            type: 'object',
          },
          type: 'upload',
        },
      },
    });
  });

  test('serialize service with binary', () => {
    expect(BinaryFileServiceSchema.serialize()).toStrictEqual({
      procedures: {
        getFile: {
          errors: {
            not: {},
          },
          init: {
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
    });
  });

  test('serialize service with errors', () => {
    expect(FallibleServiceSchema.serialize()).toStrictEqual({
      procedures: {
        divide: {
          init: {
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
          init: {
            properties: {},
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

  test('serialize backwards compatible with v1', () => {
    expect(TestServiceSchema.serializeBackwardsCompatible()).toStrictEqual({
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
          errors: {
            not: {},
          },
          type: 'rpc',
        },
        array: {
          errors: {
            not: {},
          },
          input: {
            properties: {
              n: {
                type: 'number',
              },
            },
            required: ['n'],
            type: 'object',
          },
          output: {
            items: {
              type: 'number',
            },
            type: 'array',
          },
          type: 'rpc',
        },
        arrayStream: {
          errors: {
            not: {},
          },
          init: {
            properties: {},
            type: 'object',
          },
          input: {
            properties: {
              n: {
                type: 'number',
              },
            },
            required: ['n'],
            type: 'object',
          },
          output: {
            items: {
              type: 'number',
            },
            type: 'array',
          },
          type: 'stream',
        },
        echo: {
          init: {
            properties: {},
            type: 'object',
          },
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
          errors: {
            not: {},
          },
          type: 'stream',
        },
        echoWithPrefix: {
          errors: {
            not: {},
          },
          init: {
            properties: {
              prefix: {
                type: 'string',
              },
            },
            required: ['prefix'],
            type: 'object',
          },
          input: {
            properties: {
              ignore: {
                type: 'boolean',
              },
              msg: {
                type: 'string',
              },
            },
            required: ['msg', 'ignore'],
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
        unimplementedSubscription: {
          errors: {
            not: {},
          },
          input: {
            properties: {},
            type: 'object',
          },
          output: {
            properties: {},
            type: 'object',
          },
          type: 'subscription',
        },
        unimplementedUpload: {
          errors: {
            not: {},
          },
          init: {
            properties: {},
            type: 'object',
          },
          input: {
            properties: {},
            type: 'object',
          },
          output: {
            properties: {},
            type: 'object',
          },
          type: 'upload',
        },
      },
    });
  });
});
