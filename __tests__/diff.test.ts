import { expect, describe, test } from 'vitest';
import { diffServerSchema } from '../router/diff';
import { Procedure, ServiceSchema, serializeSchema } from '../router';
import { Type } from '@sinclair/typebox';

describe('schema backwards incompatible changes', () => {
  test('service removal is incompatible', () => {
    const oldSchema = serializeSchema({
      adder: ServiceSchema.define(
        {
          initializeState: () => ({}),
        },
        {
          add: Procedure.rpc({
            input: Type.Object({}),
            output: Type.Object({}),
            handler: async (_) => ({ ok: true, payload: {} }),
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
            input: Type.Object({}),
            output: Type.Object({}),
            handler: async (_) => ({ ok: true, payload: {} }),
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
            input: Type.Object({}),
            output: Type.Object({}),
            handler: async (_) => ({ ok: true, payload: {} }),
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
            input: Type.Object({}),
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
            input: Type.Object({}),
            output: Type.Object({}),
            handler: async (_) => ({ ok: true, payload: {} }),
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
                  total: {
                    reason: 'removed-required',
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
            input: Type.Object({}),
            output: Type.Object({}),
            handler: async (_) => ({ ok: true, payload: {} }),
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
            input: Type.Object({
              total: Type.Number(),
            }),
            output: Type.Object({}),
            handler: async (_) => ({ ok: true, payload: {} }),
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
              input: {
                fieldBreakages: {
                  total: {
                    reason: 'new-required',
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
            input: Type.Object({
              total: Type.String(),
            }),
            output: Type.Object({}),
            handler: async (_) => ({ ok: true, payload: {} }),
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
            input: Type.Object({
              total: Type.Number(),
            }),
            output: Type.Object({}),
            handler: async (_) => ({ ok: true, payload: {} }),
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
              input: {
                fieldBreakages: {
                  total: {
                    reason: 'type-changed',
                    oldType: 'string',
                    newType: 'number',
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
            input: Type.Object({}),
            output: Type.Object({}),
            handler: async (_) => ({ ok: true, payload: {} }),
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
            input: Type.Object({}),
            output: Type.Object({}),
            handler: async (_) => ({ ok: true, payload: {} }),
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
            input: Type.Object({}),
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
            input: Type.Object({
              total: Type.Optional(Type.Number()),
            }),
            output: Type.Object({}),
            handler: async (_) => ({ ok: true, payload: {} }),
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
            input: Type.Object({}),
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
            input: Type.Object({}),
            output: Type.Object({}),
            handler: async (_) => ({ ok: true, payload: {} }),
          }),
        },
      ),
    });

    const diff = diffServerSchema(oldSchema, newSchema);
    expect(diff).toBeNull();
  });
});
