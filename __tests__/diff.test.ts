import { expect, describe, test } from 'vitest';
import { diffServerSchema } from '../router/diff';
import { Procedure, ServiceSchema, serializeSchema } from '../router';
import { Kind, TSchema, Type, TypeRegistry } from '@sinclair/typebox';

describe('schema backwards incompatible changes', () => {
  test('service removal is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({});

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          reason: 'removed',
        },
      },
    });
  });

  test('procedure removal is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {},
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          reason: 'modified',
          procedureBreakages: {
            add: { reason: 'removed' },
          },
        },
      },
    });
  });

  test('procedure type change is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.stream({
            init: Type.Object({}),
            input: Type.Object({}),
            output: Type.Object({}),
            handler: async (_) => {
              return;
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              newType: 'stream',
              oldType: 'rpc',
              reason: 'type-changed',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('removed required output field is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({
              total: Type.Number(),
            }),
            handler: async (_) => ({ ok: true, payload: { total: 0 } }),
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              output: {
                fieldBreakages: {
                  properties: {
                    fieldBreakages: {
                      total: {
                        reason: 'removed-required',
                      },
                    },
                    reason: 'field-breakage',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('new required input field is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({
              total: Type.Number(),
            }),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                fieldBreakages: {
                  properties: {
                    fieldBreakages: {
                      total: {
                        reason: 'new-required',
                      },
                    },
                    reason: 'field-breakage',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('field type change is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({
              total: Type.String(),
            }),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({
              total: Type.Number(),
            }),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                fieldBreakages: {
                  properties: {
                    reason: 'field-breakage',
                    fieldBreakages: {
                      total: {
                        reason: 'type-changed',
                        oldType: 'string',
                        newType: 'number',
                      },
                    },
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('replaced union with object is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Union([
              Type.Object({ total: Type.Number() }),
              Type.Object({ wat: Type.Number() }),
            ]),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({
              total: Type.Number(),
            }),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                newType: 'object',
                oldType: 'anyOf',
                reason: 'type-changed',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('swapping record and objects is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Record(Type.String(), Type.String()),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Record(Type.String(), Type.String()),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);

    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          reason: 'modified',
          procedureBreakages: {
            add: {
              reason: 'modified',
              init: {
                reason: 'type-changed',
                oldType: 'probably-record',
                newType: 'probably-object',
              },
              output: {
                reason: 'type-changed',
                oldType: 'probably-object',
                newType: 'probably-record',
              },
            },
          },
        },
      },
    });
  });

  test('changing record keys is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Record(Type.Number(), Type.String()),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Record(Type.String(), Type.String()),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);

    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                fieldBreakages: {
                  patternProperties: {
                    fieldBreakages: {
                      '^(0|[1-9][0-9]*)$': {
                        reason: 'removed-required',
                      },
                    },
                    reason: 'field-breakage',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('changing record values is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Record(Type.Number(), Type.Number()),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Record(Type.Number(), Type.String()),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                fieldBreakages: {
                  patternProperties: {
                    fieldBreakages: {
                      '^(0|[1-9][0-9]*)$': {
                        newType: 'string',
                        oldType: 'number',
                        reason: 'type-changed',
                      },
                    },
                    reason: 'field-breakage',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('replaced not with union is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Not(Type.Object({ total: Type.Number() })),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Union([
              Type.Object({ total: Type.Number() }),
              Type.Object({ wat: Type.Number() }),
            ]),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                newType: 'anyOf',
                oldType: 'not',
                reason: 'type-changed',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test("replaced not's schema is incompatible", () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Not(Type.Number()),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Not(Type.String()),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          reason: 'modified',
          procedureBreakages: {
            add: {
              reason: 'modified',
              init: {
                reason: 'field-breakage',
                fieldBreakages: {
                  not: {
                    reason: 'type-changed',
                    oldType: 'number',
                    newType: 'string',
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  test('changing intersection type is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Intersect([
              Type.Object({ x: Type.Number() }),
              Type.Object({ y: Type.Number() }),
            ]),
            output: Type.Intersect([
              Type.Object({ x: Type.Number() }),
              Type.Object({ y: Type.Number() }),
            ]),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Intersect([
              Type.Object({ x: Type.Number() }),
              Type.Object({ z: Type.Number() }),
            ]),
            output: Type.Intersect([
              Type.Object({ x: Type.Number() }),
              Type.Object({ z: Type.Number() }),
            ]),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          reason: 'modified',
          procedureBreakages: {
            add: {
              reason: 'modified',
              init: {
                reason: 'field-breakage',
                fieldBreakages: {
                  allOf: {
                    reason: 'field-breakage',
                    fieldBreakages: {
                      properties: {
                        reason: 'field-breakage',
                        fieldBreakages: {
                          y: {
                            reason: 'removed-required',
                          },
                          z: {
                            reason: 'new-required',
                          },
                        },
                      },
                    },
                  },
                },
              },
              output: {
                reason: 'field-breakage',
                fieldBreakages: {
                  allOf: {
                    reason: 'field-breakage',
                    fieldBreakages: {
                      properties: {
                        reason: 'field-breakage',
                        fieldBreakages: {
                          y: {
                            reason: 'removed-required',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  test('removing from union type input is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Union([
              Type.Object({ x: Type.Number() }),
              Type.Object({ y: Type.Number() }),
              Type.Object({ z: Type.Number() }),
            ]),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Union([
              Type.Object({ x: Type.Number() }),
              Type.Object({ y: Type.Number() }),
            ]),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                fieldBreakages: {
                  anyOf: {
                    fieldBreakages: {
                      'old-2': {
                        reason: 'removed-required',
                      },
                    },
                    reason: 'field-breakage',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('adding to union type output is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Union([
              Type.Object({ x: Type.Number() }),
              Type.Object({ y: Type.Number() }),
            ]),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Union([
              Type.Object({ x: Type.Number() }),
              Type.Object({ y: Type.Number() }),
              Type.Object({ z: Type.Number() }),
            ]),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              output: {
                fieldBreakages: {
                  anyOf: {
                    fieldBreakages: {
                      'new-2': {
                        reason: 'new-required',
                      },
                    },
                    reason: 'field-breakage',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('changing literal value is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Literal('old'),
            output: Type.Literal('old'),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Literal('new'),
            output: Type.Literal('new'),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                newType: 'string-const-new',
                oldType: 'string-const-old',
                reason: 'type-changed',
              },
              output: {
                newType: 'string-const-new',
                oldType: 'string-const-old',
                reason: 'type-changed',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('replaced non-literal with literal for input is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Literal('mystring'),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                newType: 'string-const-mystring',
                oldType: 'string',
                reason: 'type-changed',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('replaced literal with non-literal for output is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Literal('mystring'),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              output: {
                newType: 'string',
                oldType: 'string-const-mystring',
                reason: 'type-changed',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('array minItems increasing for input is not compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { minItems: 1 }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { minItems: 2 }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                fieldBreakages: {
                  minItems: {
                    newType: '2',
                    oldType: '1',
                    reason: 'type-changed',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('array minItems decreasing for output is not compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { minItems: 2 }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { minItems: 1 }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              output: {
                fieldBreakages: {
                  minItems: {
                    newType: '1',
                    oldType: '2',
                    reason: 'type-changed',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('array maxItems increasing for output is not compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { maxItems: 1 }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { maxItems: 2 }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              output: {
                fieldBreakages: {
                  maxItems: {
                    newType: '2',
                    oldType: '1',
                    reason: 'type-changed',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('array maxItems decreasing for input is not compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { maxItems: 2 }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { maxItems: 1 }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                fieldBreakages: {
                  maxItems: {
                    newType: '1',
                    oldType: '2',
                    reason: 'type-changed',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('array minContains increasing for input is not compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { minContains: 1 }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { minContains: 2 }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                fieldBreakages: {
                  minContains: {
                    newType: '2',
                    oldType: '1',
                    reason: 'type-changed',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('array minContains decreasing for output is not compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { minContains: 2 }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { minContains: 1 }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              output: {
                fieldBreakages: {
                  minContains: {
                    newType: '1',
                    oldType: '2',
                    reason: 'type-changed',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('array maxContains increasing for output is not compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { maxContains: 1 }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { maxContains: 2 }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              output: {
                fieldBreakages: {
                  maxContains: {
                    newType: '2',
                    oldType: '1',
                    reason: 'type-changed',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('array maxContains decreasing for input is not compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { maxContains: 2 }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { maxContains: 1 }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                fieldBreakages: {
                  maxContains: {
                    newType: '1',
                    oldType: '2',
                    reason: 'type-changed',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('array unique items turned on for client is not compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { uniqueItems: false }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { uniqueItems: true }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                fieldBreakages: {
                  uniqueItems: {
                    newType: 'true',
                    oldType: 'false',
                    reason: 'type-changed',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('array contains added for input is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String()),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { contains: Type.Literal('wow') }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                fieldBreakages: {
                  contains: {
                    newType: 'contains',
                    oldType: 'no-contains',
                    reason: 'type-changed',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('array contains type changed is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { contains: Type.String() }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { contains: Type.Object({}) }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                fieldBreakages: {
                  contains: {
                    newType: 'object',
                    oldType: 'string',
                    reason: 'type-changed',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('upgrade optional client->server field to required is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({
              total: Type.Optional(Type.Number()),
            }),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({
              total: Type.Number(),
            }),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              init: {
                fieldBreakages: {
                  properties: {
                    fieldBreakages: {
                      total: {
                        reason: 'new-required',
                      },
                    },
                    reason: 'field-breakage',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });

  test('downgrade require server->client field to optional is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({
              total: Type.Number(),
            }),
            handler: async (_) => ({ ok: true, payload: { total: 0 } }),
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({
              total: Type.Optional(Type.Number()),
            }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual({
      serviceBreakages: {
        adder: {
          procedureBreakages: {
            add: {
              output: {
                fieldBreakages: {
                  properties: {
                    fieldBreakages: {
                      total: {
                        reason: 'removed-required',
                      },
                    },
                    reason: 'field-breakage',
                  },
                },
                reason: 'field-breakage',
              },
              reason: 'modified',
            },
          },
          reason: 'modified',
        },
      },
    });
  });
});

describe('schema backwards compatible changes', () => {
  test('new service is compatible', () => {
    const oldSchema = serializeSchema({});

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toBeNull();
  });

  test('new procedure is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {},
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toBeNull();
  });

  test('new optional field is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({}),
            handler: async (_) => ({ ok: true, payload: { total: 0 } }),
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({
              total: Type.Optional(Type.Number()),
            }),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toBeNull();
  });

  test('removed optional output field is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({
              total: Type.Optional(Type.Number()),
            }),
            handler: async (_) => ({ ok: true, payload: { total: 0 } }),
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toBeNull();
  });

  test('replaced non-literal with literal from the same type for output is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.String({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Literal('mystring'),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual(null);
  });

  test('array minItems increasing for output is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { minItems: 1 }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { minItems: 2 }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual(null);
  });

  test('array minItems decreasing for input is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { minItems: 2 }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { minItems: 1 }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual(null);
  });

  test('array maxItems decreasing for output is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { maxItems: 2 }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { maxItems: 1 }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual(null);
  });

  test('array maxItems increasing for input is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { maxItems: 1 }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { maxItems: 2 }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual(null);
  });

  test('array minContains increasing for output is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { minContains: 1 }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { minContains: 2 }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual(null);
  });

  test('array minContains decreasing for input is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { minContains: 2 }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { minContains: 1 }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual(null);
  });

  test('array maxContains decreasing for output is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { maxContains: 2 }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { maxContains: 1 }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual(null);
  });

  test('array maxContains increasing for input is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { maxContains: 1 }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { maxContains: 2 }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual(null);
  });

  test('array unique items turned off for input is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { uniqueItems: true }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Array(Type.String(), { uniqueItems: false }),
            output: Type.String(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual(null);
  });

  test('array unique items turned on for output is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { uniqueItems: false }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), { uniqueItems: true }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual(null);
  });

  test('array contains added for output is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String()),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.String(),
            output: Type.Array(Type.String(), {
              contains: Type.Literal('wow'),
            }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual(null);
  });

  test('adding to union type input is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Union([
              Type.Object({ x: Type.Number() }),
              Type.Object({ y: Type.Number() }),
            ]),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Union([
              Type.Object({ x: Type.Number() }),
              Type.Object({ y: Type.Number() }),
              Type.Object({ z: Type.Number() }),
            ]),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual(null);
  });

  test('removing from union type output is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Union([
              Type.Object({ x: Type.Number() }),
              Type.Object({ y: Type.Number() }),
              Type.Object({ z: Type.Number() }),
            ]),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Union([
              Type.Object({ x: Type.Number() }),
              Type.Object({ y: Type.Number() }),
            ]),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toEqual(null);
  });

  test('downgrade required client->server field to optional is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({
              total: Type.Number(),
            }),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({
              total: Type.Optional(Type.Number()),
            }),
            output: Type.Object({}),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toBeNull();
  });

  test('upgrade optional server->client field to require is compatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({
              total: Type.Optional(Type.Number()),
            }),
            handler: async (_) => ({ ok: true, payload: { total: 0 } }),
          }),
        },
      ),
    });

    const newSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object({
              total: Type.Number(),
            }),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toBeNull();
  });
});

describe('unsupported schema', () => {
  test('oneof', () => {
    function UnionOneOf(): TSchema {
      if (!TypeRegistry.Has('TESTING_ONEOF')) {
        TypeRegistry.Set('TESTING_ONEOF', () => true);
      }

      return { [Kind]: 'UnionOneOf', oneOf: [] } as unknown as TSchema;
    }

    const schema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: UnionOneOf(),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    expect(() => diffServerSchema(schema, schema)).toThrow();
  });

  test('object additionalProperties', () => {
    const schema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object(
              {
                hey: Type.Boolean(),
              },
              {
                additionalProperties: Type.Literal('wat'),
              },
            ),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    expect(() => diffServerSchema(schema, schema)).toThrow();
  });

  test('object maxProperties', () => {
    const schema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object(
              {
                hey: Type.Boolean(),
              },
              {
                maxProperties: 1,
              },
            ),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    expect(() => diffServerSchema(schema, schema)).toThrow();
  });

  test('object minProperties', () => {
    const schema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            init: Type.Object({}),
            output: Type.Object(
              {
                hey: Type.Boolean(),
              },
              {
                minProperties: 1,
              },
            ),
            handler: () => {
              throw new Error('unimplemented');
            },
          }),
        },
      ),
    });

    expect(() => diffServerSchema(schema, schema)).toThrow();
  });
});
