// python-client/tests/extract_test_schema.ts
import fs from "node:fs";
import path from "node:path";

// router/services.ts
import { Type as Type2, Kind as Kind2 } from "@sinclair/typebox";

// router/errors.ts
import {
  Kind,
  Type
} from "@sinclair/typebox";
var UNCAUGHT_ERROR_CODE = "UNCAUGHT_ERROR";
var UNEXPECTED_DISCONNECT_CODE = "UNEXPECTED_DISCONNECT";
var INVALID_REQUEST_CODE = "INVALID_REQUEST";
var CANCEL_CODE = "CANCEL";
var ErrResultSchema = (t) => Type.Object({
  ok: Type.Literal(false),
  payload: t
});
var ValidationErrorDetails = Type.Object({
  path: Type.String(),
  message: Type.String()
});
var ValidationErrors = Type.Array(ValidationErrorDetails);
var CancelErrorSchema = Type.Object({
  code: Type.Literal(CANCEL_CODE),
  message: Type.String()
});
var CancelResultSchema = ErrResultSchema(CancelErrorSchema);
var ReaderErrorSchema = Type.Union([
  Type.Object({
    code: Type.Literal(UNCAUGHT_ERROR_CODE),
    message: Type.String()
  }),
  Type.Object({
    code: Type.Literal(UNEXPECTED_DISCONNECT_CODE),
    message: Type.String()
  }),
  Type.Object({
    code: Type.Literal(INVALID_REQUEST_CODE),
    message: Type.String(),
    extras: Type.Optional(
      Type.Object({
        firstValidationErrors: Type.Array(ValidationErrorDetails),
        totalErrors: Type.Number()
      })
    )
  }),
  CancelErrorSchema
]);
var ReaderErrorResultSchema = ErrResultSchema(ReaderErrorSchema);
function isUnion(schema2) {
  return schema2[Kind] === "Union";
}
function flattenErrorType(errType) {
  if (!isUnion(errType)) {
    return errType;
  }
  const flattenedTypes = [];
  function flatten(type) {
    if (isUnion(type)) {
      for (const t of type.anyOf) {
        flatten(t);
      }
    } else {
      flattenedTypes.push(type);
    }
  }
  flatten(errType);
  return Type.Union(flattenedTypes);
}

// router/services.ts
function Strict(schema2) {
  return JSON.parse(JSON.stringify(schema2));
}
function serializeSchema(services2, handshakeSchema) {
  const serializedServiceObject = Object.entries(services2).reduce((acc, [name, value]) => {
    acc[name] = value.serialize();
    return acc;
  }, {});
  const schema2 = {
    services: serializedServiceObject
  };
  if (handshakeSchema) {
    schema2.handshakeSchema = Strict(handshakeSchema);
  }
  return schema2;
}
function createServiceSchema() {
  return class ServiceSchema2 {
    /**
     * Factory function for creating a fresh state.
     */
    initializeState;
    /**
     * The procedures for this service.
     */
    procedures;
    /**
     * @param config - The configuration for this service.
     * @param procedures - The procedures for this service.
     */
    constructor(config, procedures) {
      this.initializeState = config.initializeState;
      this.procedures = procedures;
    }
    /**
     * Creates a {@link ServiceScaffold}, which can be used to define procedures
     * that can then be merged into a {@link ServiceSchema}, via the scaffold's
     * `finalize` method.
     *
     * There are two patterns that work well with this method. The first is using
     * it to separate the definition of procedures from the definition of the
     * service's configuration:
     * ```ts
     * const MyServiceScaffold = ServiceSchema.scaffold({
     *   initializeState: () => ({ count: 0 }),
     * });
     *
     * const incrementProcedures = MyServiceScaffold.procedures({
     *   increment: Procedure.rpc({
     *     requestInit: Type.Object({ amount: Type.Number() }),
     *     responseData: Type.Object({ current: Type.Number() }),
     *     async handler(ctx, init) {
     *       ctx.state.count += init.amount;
     *       return Ok({ current: ctx.state.count });
     *     }
     *   }),
     * })
     *
     * const MyService = MyServiceScaffold.finalize({
     *   ...incrementProcedures,
     *   // you can also directly define procedures here
     * });
     * ```
     * This might be really handy if you have a very large service and you're
     * wanting to split it over multiple files. You can define the scaffold
     * in one file, and then import that scaffold in other files where you
     * define procedures - and then finally import the scaffolds and your
     * procedure objects in a final file where you finalize the scaffold into
     * a service schema.
     *
     * The other way is to use it like in a builder pattern:
     * ```ts
     * const MyService = ServiceSchema
     *   .scaffold({ initializeState: () => ({ count: 0 }) })
     *   .finalize({
     *     increment: Procedure.rpc({
     *       requestInit: Type.Object({ amount: Type.Number() }),
     *       responseData: Type.Object({ current: Type.Number() }),
     *       async handler(ctx, init) {
     *         ctx.state.count += init.amount;
     *         return Ok({ current: ctx.state.count });
     *       }
     *     }),
     *   })
     * ```
     * Depending on your preferences, this may be a more appealing way to define
     * a schema versus using the {@link ServiceSchema.define} method.
     */
    static scaffold(config) {
      return new ServiceScaffold(config);
    }
    // actual implementation
    static define(configOrProcedures, maybeProcedures) {
      let config;
      let procedures;
      if ("initializeState" in configOrProcedures && typeof configOrProcedures.initializeState === "function") {
        if (!maybeProcedures) {
          throw new Error("Expected procedures to be defined");
        }
        config = configOrProcedures;
        procedures = maybeProcedures;
      } else {
        config = { initializeState: () => ({}) };
        procedures = configOrProcedures;
      }
      return new ServiceSchema2(config, procedures);
    }
    /**
     * Serializes this schema's procedures into a plain object that is JSON compatible.
     */
    serialize() {
      return {
        procedures: Object.fromEntries(
          Object.entries(this.procedures).map(([procName, procDef]) => [
            procName,
            {
              init: Strict(procDef.requestInit),
              output: Strict(procDef.responseData),
              errors: getSerializedProcErrors(procDef),
              // Only add `description` field if the type declares it.
              ..."description" in procDef ? { description: procDef.description } : {},
              type: procDef.type,
              // Only add the `input` field if the type declares it.
              ..."requestData" in procDef ? {
                input: Strict(procDef.requestData)
              } : {}
            }
          ])
        )
      };
    }
    // TODO remove once clients migrate to v2
    /**
     * Same as {@link ServiceSchema.serialize}, but with a format that is compatible with
     * protocol v1. This is useful to be able to continue to generate schemas for older
     * clients as they are still supported.
     */
    serializeV1Compat() {
      return {
        procedures: Object.fromEntries(
          Object.entries(this.procedures).map(
            ([procName, procDef]) => {
              if (procDef.type === "rpc" || procDef.type === "subscription") {
                return [
                  procName,
                  {
                    // BACKWARDS COMPAT: map init to input for protocolv1
                    // this is the only change needed to make it compatible.
                    input: Strict(procDef.requestInit),
                    output: Strict(procDef.responseData),
                    errors: getSerializedProcErrors(procDef),
                    // Only add `description` field if the type declares it.
                    ..."description" in procDef ? { description: procDef.description } : {},
                    type: procDef.type
                  }
                ];
              }
              return [
                procName,
                {
                  init: Strict(procDef.requestInit),
                  output: Strict(procDef.responseData),
                  errors: getSerializedProcErrors(procDef),
                  // Only add `description` field if the type declares it.
                  ..."description" in procDef ? { description: procDef.description } : {},
                  type: procDef.type,
                  input: Strict(procDef.requestData)
                }
              ];
            }
          )
        )
      };
    }
    /**
     * Instantiates this schema into a {@link Service} object.
     *
     * You probably don't need this, usually the River server will handle this
     * for you.
     */
    instantiate(extendedContext) {
      const state = this.initializeState(extendedContext);
      const dispose = async () => {
        await state[Symbol.asyncDispose]?.();
        state[Symbol.dispose]?.();
      };
      return Object.freeze({
        state,
        procedures: this.procedures,
        [Symbol.asyncDispose]: dispose
      });
    }
  };
}
function getSerializedProcErrors(procDef) {
  if (!("responseError" in procDef) || procDef.responseError[Kind2] === "Never") {
    return Strict(ReaderErrorSchema);
  }
  const withProtocolErrors = flattenErrorType(
    Type2.Union([procDef.responseError, ReaderErrorSchema])
  );
  return Strict(withProtocolErrors);
}
var ServiceScaffold = class {
  /**
   * The configuration for this service.
   */
  config;
  /**
   * @param config - The configuration for this service.
   */
  constructor(config) {
    this.config = config;
  }
  /**
   * Define procedures for this service. Use the {@link Procedure} constructors
   * to create them. This returns the procedures object, which can then be
   * passed to {@link ServiceSchema.finalize} to create a {@link ServiceSchema}.
   *
   * @example
   * ```
   * const myProcedures = MyServiceScaffold.procedures({
   *   myRPC: Procedure.rpc({
   *     // ...
   *   }),
   * });
   *
   * const MyService = MyServiceScaffold.finalize({
   *   ...myProcedures,
   * });
   * ```
   *
   * @param procedures - The procedures for this service.
   */
  procedures(procedures) {
    return procedures;
  }
  /**
   * Finalizes the scaffold into a {@link ServiceSchema}. This is where you
   * provide the service's procedures and get a {@link ServiceSchema} in return.
   *
   * You can directly define procedures here, or you can define them separately
   * with the {@link ServiceScaffold.procedures} method, and then pass them here.
   *
   * @example
   * ```
   * const MyService = MyServiceScaffold.finalize({
   *  myRPC: Procedure.rpc({
   *   // ...
   *  }),
   *  // e.g. from the procedures method
   *  ...myOtherProcedures,
   * });
   * ```
   */
  finalize(procedures) {
    return createServiceSchema().define(
      this.config,
      procedures
    );
  }
};

// router/result.ts
import { Type as Type3 } from "@sinclair/typebox";
var AnyResultSchema = Type3.Union([
  Type3.Object({
    ok: Type3.Literal(false),
    payload: Type3.Object({
      code: Type3.String(),
      message: Type3.String(),
      extras: Type3.Optional(Type3.Unknown())
    })
  }),
  Type3.Object({
    ok: Type3.Literal(true),
    payload: Type3.Unknown()
  })
]);
function Ok(payload) {
  return {
    ok: true,
    payload
  };
}

// router/procedures.ts
import { Type as Type4 } from "@sinclair/typebox";
function rpc({
  requestInit,
  responseData,
  responseError = Type4.Never(),
  description,
  handler
}) {
  return {
    ...description ? { description } : {},
    type: "rpc",
    requestInit,
    responseData,
    responseError,
    handler
  };
}
function upload({
  requestInit,
  requestData,
  responseData,
  responseError = Type4.Never(),
  description,
  handler
}) {
  return {
    type: "upload",
    ...description ? { description } : {},
    requestInit,
    requestData,
    responseData,
    responseError,
    handler
  };
}
function subscription({
  requestInit,
  responseData,
  responseError = Type4.Never(),
  description,
  handler
}) {
  return {
    type: "subscription",
    ...description ? { description } : {},
    requestInit,
    responseData,
    responseError,
    handler
  };
}
function stream({
  requestInit,
  requestData,
  responseData,
  responseError = Type4.Never(),
  description,
  handler
}) {
  return {
    type: "stream",
    ...description ? { description } : {},
    requestInit,
    requestData,
    responseData,
    responseError,
    handler
  };
}
var Procedure = {
  rpc,
  upload,
  subscription,
  stream
};

// python-client/tests/extract_test_schema.ts
import { Type as Type5 } from "@sinclair/typebox";
var ServiceSchema = createServiceSchema();
var TestServiceSchema = ServiceSchema.define({
  add: Procedure.rpc({
    requestInit: Type5.Object({ n: Type5.Number() }),
    responseData: Type5.Object({ result: Type5.Number() }),
    responseError: Type5.Never(),
    async handler({ reqInit }) {
      return Ok({ result: reqInit.n });
    }
  }),
  echo: Procedure.stream({
    requestInit: Type5.Object({}),
    requestData: Type5.Object({
      msg: Type5.String(),
      ignore: Type5.Optional(Type5.Boolean())
    }),
    responseData: Type5.Object({ response: Type5.String() }),
    responseError: Type5.Never(),
    async handler({ resWritable }) {
      resWritable.close();
    }
  }),
  echoWithPrefix: Procedure.stream({
    requestInit: Type5.Object({ prefix: Type5.String() }),
    requestData: Type5.Object({
      msg: Type5.String(),
      ignore: Type5.Optional(Type5.Boolean())
    }),
    responseData: Type5.Object({ response: Type5.String() }),
    responseError: Type5.Never(),
    async handler({ resWritable }) {
      resWritable.close();
    }
  }),
  echoBinary: Procedure.rpc({
    requestInit: Type5.Object({ data: Type5.Uint8Array() }),
    responseData: Type5.Object({
      data: Type5.Uint8Array(),
      length: Type5.Number()
    }),
    responseError: Type5.Never(),
    async handler({ reqInit }) {
      return Ok({ data: reqInit.data, length: reqInit.data.length });
    }
  })
});
var OrderingServiceSchema = ServiceSchema.define({
  add: Procedure.rpc({
    requestInit: Type5.Object({ n: Type5.Number() }),
    responseData: Type5.Object({ n: Type5.Number() }),
    responseError: Type5.Never(),
    async handler({ reqInit }) {
      return Ok({ n: reqInit.n });
    }
  }),
  getAll: Procedure.rpc({
    requestInit: Type5.Object({}),
    responseData: Type5.Object({ msgs: Type5.Array(Type5.Number()) }),
    responseError: Type5.Never(),
    async handler(_ctx) {
      return Ok({ msgs: [] });
    }
  })
});
var FallibleServiceSchema = ServiceSchema.define({
  divide: Procedure.rpc({
    requestInit: Type5.Object({ a: Type5.Number(), b: Type5.Number() }),
    responseData: Type5.Object({ result: Type5.Number() }),
    responseError: Type5.Union([
      Type5.Object({
        code: Type5.Literal("DIV_BY_ZERO"),
        message: Type5.String()
      }),
      Type5.Object({
        code: Type5.Literal("INFINITY"),
        message: Type5.String()
      })
    ]),
    async handler({ reqInit }) {
      return Ok({ result: reqInit.a / reqInit.b });
    }
  }),
  echo: Procedure.stream({
    requestInit: Type5.Object({}),
    requestData: Type5.Object({
      msg: Type5.String(),
      throwResult: Type5.Optional(Type5.Boolean()),
      throwError: Type5.Optional(Type5.Boolean())
    }),
    responseData: Type5.Object({ response: Type5.String() }),
    responseError: Type5.Object({
      code: Type5.Literal("STREAM_ERROR"),
      message: Type5.String()
    }),
    async handler({ resWritable }) {
      resWritable.close();
    }
  })
});
var SubscribableServiceSchema = ServiceSchema.define({
  add: Procedure.rpc({
    requestInit: Type5.Object({ n: Type5.Number() }),
    responseData: Type5.Object({ result: Type5.Number() }),
    responseError: Type5.Never(),
    async handler({ reqInit }) {
      return Ok({ result: reqInit.n });
    }
  }),
  value: Procedure.subscription({
    requestInit: Type5.Object({}),
    responseData: Type5.Object({ count: Type5.Number() }),
    responseError: Type5.Never(),
    async handler({ resWritable }) {
      resWritable.write(Ok({ count: 0 }));
      resWritable.close();
    }
  })
});
var UploadableServiceSchema = ServiceSchema.define({
  addMultiple: Procedure.upload({
    requestInit: Type5.Object({}),
    requestData: Type5.Object({ n: Type5.Number() }),
    responseData: Type5.Object({ result: Type5.Number() }),
    responseError: Type5.Never(),
    async handler(_ctx) {
      return Ok({ result: 0 });
    }
  }),
  addMultipleWithPrefix: Procedure.upload({
    requestInit: Type5.Object({ prefix: Type5.String() }),
    requestData: Type5.Object({ n: Type5.Number() }),
    responseData: Type5.Object({ result: Type5.String() }),
    responseError: Type5.Never(),
    async handler(_ctx) {
      return Ok({ result: "" });
    }
  }),
  cancellableAdd: Procedure.upload({
    requestInit: Type5.Object({}),
    requestData: Type5.Object({ n: Type5.Number() }),
    responseData: Type5.Object({ result: Type5.Number() }),
    responseError: Type5.Object({
      code: Type5.Literal("CANCEL"),
      message: Type5.String()
    }),
    async handler(_ctx) {
      return Ok({ result: 0 });
    }
  })
});
var CancellationServiceSchema = ServiceSchema.define({
  blockingRpc: Procedure.rpc({
    requestInit: Type5.Object({}),
    responseData: Type5.Object({}),
    responseError: Type5.Never(),
    async handler(_ctx) {
      return Ok({});
    }
  }),
  blockingStream: Procedure.stream({
    requestInit: Type5.Object({}),
    requestData: Type5.Object({}),
    responseData: Type5.Object({}),
    responseError: Type5.Never(),
    async handler({ resWritable }) {
      resWritable.close();
    }
  }),
  blockingUpload: Procedure.upload({
    requestInit: Type5.Object({}),
    requestData: Type5.Object({}),
    responseData: Type5.Object({}),
    responseError: Type5.Never(),
    async handler(_ctx) {
      return Ok({});
    }
  }),
  blockingSubscription: Procedure.subscription({
    requestInit: Type5.Object({}),
    responseData: Type5.Object({}),
    responseError: Type5.Never(),
    async handler({ resWritable }) {
      resWritable.close();
    }
  }),
  immediateRpc: Procedure.rpc({
    requestInit: Type5.Object({}),
    responseData: Type5.Object({ done: Type5.Boolean() }),
    responseError: Type5.Never(),
    async handler(_ctx) {
      return Ok({ done: true });
    }
  }),
  immediateStream: Procedure.stream({
    requestInit: Type5.Object({}),
    requestData: Type5.Object({}),
    responseData: Type5.Object({ done: Type5.Boolean() }),
    responseError: Type5.Never(),
    async handler({ resWritable }) {
      resWritable.close();
    }
  }),
  immediateUpload: Procedure.upload({
    requestInit: Type5.Object({}),
    requestData: Type5.Object({}),
    responseData: Type5.Object({ done: Type5.Boolean() }),
    responseError: Type5.Never(),
    async handler(_ctx) {
      return Ok({ done: true });
    }
  }),
  immediateSubscription: Procedure.subscription({
    requestInit: Type5.Object({}),
    responseData: Type5.Object({ done: Type5.Boolean() }),
    responseError: Type5.Never(),
    async handler({ resWritable }) {
      resWritable.close();
    }
  }),
  countedStream: Procedure.stream({
    requestInit: Type5.Object({ total: Type5.Number() }),
    requestData: Type5.Object({}),
    responseData: Type5.Object({ i: Type5.Number() }),
    responseError: Type5.Never(),
    async handler({ resWritable }) {
      resWritable.close();
    }
  })
});
var services = {
  test: TestServiceSchema,
  ordering: OrderingServiceSchema,
  fallible: FallibleServiceSchema,
  subscribable: SubscribableServiceSchema,
  uploadable: UploadableServiceSchema,
  cancel: CancellationServiceSchema
};
var schema = serializeSchema(services);
var outPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "test_schema.json"
);
fs.writeFileSync(outPath, JSON.stringify(schema, null, 2));
console.log(`Wrote schema to ${outPath}`);
