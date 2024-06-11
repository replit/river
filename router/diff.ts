/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { TProperties, TAnySchema } from '@sinclair/typebox';
import type {
  SerializedServerSchema,
  SerializedServiceSchema,
  SerializedProcedureSchema,
} from '../router';

export interface ServerBreakage {
  serviceBreakages: Record<string, ServiceBreakage>;
}

export type ServiceBreakage =
  | {
      reason: 'removed';
    }
  | {
      reason: 'modified';
      procedureBreakages: Record<string, ProcedureBreakage>;
    };

export type ProcedureBreakage =
  | {
      reason: 'removed';
    }
  | { reason: 'type-changed'; oldType: string; newType: string }
  | {
      reason: 'modified';
      input?: PayloadBreakage;
      init?: PayloadBreakage;
      output?: PayloadBreakage;
    };

export type PayloadBreakage =
  | {
      reason: 'type-changed';
      oldType: string;
      newType: string;
    }
  | { reason: 'new-required' }
  | { reason: 'removed-required' }
  | {
      reason: 'field-breakage';
      fieldBreakages: Record<string, PayloadBreakage>;
    };

export function diffServerSchema(
  oldServer: SerializedServerSchema,
  newServer: SerializedServerSchema,
): ServerBreakage | null {
  const allServices = new Set([
    ...Object.keys(oldServer.services),
    ...Object.keys(newServer.services),
  ]);

  const breakages: Record<string, ServiceBreakage> = {};
  for (const serviceName of allServices) {
    const oldService = oldServer.services[serviceName];
    const newService = newServer.services[serviceName];

    const breakage = diffService(oldService, newService);
    if (breakage) {
      breakages[serviceName] = breakage;
    }
  }

  if (Object.keys(breakages).length) {
    return { serviceBreakages: breakages };
  }

  return null;
}

function diffService(
  oldService: SerializedServiceSchema | null,
  newService: SerializedServiceSchema | null,
): ServiceBreakage | null {
  if (!newService) {
    return { reason: 'removed' };
  }
  // New service, perfectly fine.
  if (!oldService) {
    return null;
  }

  const allProcedures = new Set([
    ...Object.keys(oldService.procedures),
    ...Object.keys(newService.procedures),
  ]);

  const breakages: Record<string, ProcedureBreakage> = {};
  for (const procedureName of allProcedures) {
    const aProcedure = oldService.procedures[procedureName];
    const bProcedure = newService.procedures[procedureName];

    const breakage = diffProcedure(aProcedure, bProcedure);
    if (breakage) {
      breakages[procedureName] = breakage;
    }
  }
  if (Object.keys(breakages).length) {
    return { reason: 'modified', procedureBreakages: breakages };
  }

  return null;
}

function diffProcedure(
  oldProcedure: SerializedProcedureSchema | null,
  newProcedure: SerializedProcedureSchema | null,
): ProcedureBreakage | null {
  if (!newProcedure) {
    return { reason: 'removed' };
  }
  // New service, perfectly fine.
  if (!oldProcedure) {
    return null;
  }

  if (oldProcedure.type !== newProcedure.type) {
    return {
      reason: 'type-changed',
      oldType: oldProcedure.type,
      newType: newProcedure.type,
    };
  }

  const inputBreakage = diffProcedureField(
    oldProcedure.input,
    newProcedure.input,
    'client',
  );
  const initBreakage = diffProcedureField(
    oldProcedure.init,
    newProcedure.init,
    'client',
  );
  const outputBreakage = diffProcedureField(
    oldProcedure.output,
    newProcedure.output,
    'server',
  );

  if (inputBreakage ?? initBreakage ?? outputBreakage) {
    const result: ProcedureBreakage = {
      reason: 'modified',
    };
    if (inputBreakage) {
      result.input = inputBreakage;
    }
    if (initBreakage) {
      result.init = initBreakage;
    }
    if (outputBreakage) {
      result.output = outputBreakage;
    }
    return result;
  }

  return null;
}

function diffProcedureField(
  oldSchema: TAnySchema | undefined,
  newSchema: TAnySchema | undefined,
  origin: 'server' | 'client',
): PayloadBreakage | null {
  if (!oldSchema && !newSchema) {
    return null;
  }

  const diffBreakage = diffRequired(oldSchema, newSchema, origin, false, false);
  if (diffBreakage) {
    return diffBreakage;
  }

  if (!oldSchema || !newSchema) {
    throw new Error('Appease typescript, this should never happen');
  }

  return diffJSONSchema(oldSchema, newSchema, origin);
}

function diffRequired(
  oldSchema: TAnySchema | undefined,
  newSchema: TAnySchema | undefined,
  origin: 'server' | 'client',
  oldRequired: boolean,
  newRequired: boolean,
): PayloadBreakage | null {
  if (!newSchema && !oldSchema) {
    throw new Error('Both old and new schema are undefined');
  }

  // old server will send this field, new client will not
  if (!newSchema) {
    // This is only okay if the the field was optional and the origin is the server.
    if (!oldRequired && origin == 'server') {
      return null;
    }
    return { reason: 'removed-required' };
  }
  if (!oldSchema) {
    if (newRequired && origin === 'client') {
      return { reason: 'new-required' };
    }
    // New field, perfectly fine.
    return null;
  }

  if (origin === 'client' && !oldRequired && newRequired) {
    return { reason: 'new-required' };
  }
  if (origin === 'server' && oldRequired && !newRequired) {
    return { reason: 'removed-required' };
  }

  return null;
}

function diffJSONSchema(
  oldSchema: TAnySchema,
  newSchema: TAnySchema,
  origin: 'server' | 'client',
): PayloadBreakage | null {
  if (oldSchema.type !== newSchema.type) {
    return {
      reason: 'type-changed',
      oldType: getReportingType(oldSchema),
      newType: getReportingType(newSchema),
    };
  }

  if (getReportingType(oldSchema) !== getReportingType(newSchema)) {
    return {
      reason: 'type-changed',
      oldType: getReportingType(oldSchema),
      newType: getReportingType(newSchema),
    };
  }

  if (
    'const' in oldSchema &&
    'const' in newSchema &&
    oldSchema.const !== newSchema.const
  ) {
    return {
      reason: 'type-changed',
      oldType: `${getReportingType(oldSchema)}-const-${oldSchema.const}`,
      newType: `${getReportingType(newSchema)}-const-${newSchema.const}`,
    };
  }

  // if const in old and coming from the server, then it's not okay
  if ('const' in oldSchema && !('const' in newSchema) && origin === 'server') {
    return {
      reason: 'type-changed',
      oldType: `${getReportingType(oldSchema)}-const-${oldSchema.const}`,
      newType: getReportingType(newSchema),
    };
  }

  if ('const' in newSchema && !('const' in oldSchema) && origin === 'client') {
    return {
      reason: 'type-changed',
      oldType: getReportingType(oldSchema),
      newType: `${getReportingType(newSchema)}-const-${newSchema.const}`,
    };
  }

  const breakages: Record<string, PayloadBreakage> = {};
  if ('$ref' in newSchema) {
    // TRef
    if (newSchema.$ref !== oldSchema.$ref) {
      return {
        reason: 'type-changed',
        oldType: getReportingType(oldSchema),
        newType: getReportingType(newSchema),
      };
    }
  } else if ('not' in newSchema) {
    // TNot
    const notBreakage = diffJSONSchema(
      oldSchema.not as TAnySchema,
      newSchema.not as TAnySchema,
      origin,
    );

    if (notBreakage) {
      breakages.not = notBreakage;
    }
  } else if ('anyOf' in newSchema) {
    // TUnion or TEnum

    // best effort, permissiveness relies on not changing order, but it's the best
    // we can do without going too wild doing a matrix diff

    const oldAnyOfStringified = oldSchema.anyOf
      .map((el: unknown) => JSON.stringify(el))
      .sort();
    const newAnyOfStringified = newSchema.anyOf
      .map((el: unknown) => JSON.stringify(el))
      .sort();

    const anyOfBreakages: Record<string, PayloadBreakage> = {};

    for (let i = 0; i < oldAnyOfStringified.length; i++) {
      if (newAnyOfStringified.includes(oldAnyOfStringified[i])) {
        // perfect match
        continue;
      }

      if (!newAnyOfStringified[i]) {
        if (origin === 'server') {
          continue;
        }

        anyOfBreakages[`old-${i}`] = { reason: 'removed-required' };
      } else {
        const breakage = diffJSONSchema(
          JSON.parse(oldAnyOfStringified[i]),
          JSON.parse(newAnyOfStringified[i]),
          origin,
        );

        if (breakage) {
          anyOfBreakages[`old-${i}`] = breakage;
        }
      }
    }

    for (let i = 0; i < newAnyOfStringified.length; i++) {
      if (oldAnyOfStringified.includes(newAnyOfStringified[i])) {
        // perfect match
        continue;
      }

      if (!oldAnyOfStringified[i]) {
        if (origin === 'client') {
          continue;
        }

        anyOfBreakages[`new-${i}`] = { reason: 'new-required' };
      } else {
        const breakage = diffJSONSchema(
          JSON.parse(oldAnyOfStringified[i]),
          JSON.parse(newAnyOfStringified[i]),
          origin,
        );

        if (breakage) {
          anyOfBreakages[`new-${i}`] = breakage;
        }
      }
    }

    if (Object.keys(anyOfBreakages).length > 0) {
      breakages.anyOf = {
        reason: 'field-breakage',
        fieldBreakages: anyOfBreakages,
      };
    }
  } else if ('oneOf' in newSchema) {
    throw new Error('oneOf is not supported, typebox does not emit it');
  } else if ('allOf' in newSchema) {
    // TIntersect

    // best effort, permissiveness relies on not changing order and not changing the
    // types in the intersection

    if (newSchema.allOf.length !== oldSchema.allOf.length) {
      breakages.allOf = {
        reason: 'type-changed',
        oldType: `${oldSchema.allOf}`,
        newType: `${newSchema.allOf}`,
      };
    } else {
      for (let i = 0; i < newSchema.allOf.length; i++) {
        const breakage = diffJSONSchema(
          oldSchema.allOf[i],
          newSchema.allOf[i],
          origin,
        );

        if (breakage) {
          breakages.allOf = breakage;
          break;
        }
      }
    }
  } else if (newSchema.type === 'array') {
    // TArray or TTuple
    const itemsBreakages = diffJSONSchema(
      oldSchema.items as TAnySchema,
      newSchema.items as TAnySchema,
      origin,
    );

    if (itemsBreakages) {
      breakages.items = itemsBreakages;
    }

    if (oldSchema.minItems < newSchema.minItems) {
      if (origin === 'client') {
        breakages.minItems = {
          reason: 'type-changed',
          oldType: `${oldSchema.minItems}`,
          newType: `${newSchema.minItems}`,
        };
      }
    } else if (oldSchema.minItems > newSchema.minItems) {
      if (origin === 'server') {
        breakages.minItems = {
          reason: 'type-changed',
          oldType: `${oldSchema.minItems}`,
          newType: `${newSchema.minItems}`,
        };
      }
    }

    if (oldSchema.maxItems < newSchema.maxItems) {
      if (origin === 'server') {
        breakages.maxItems = {
          reason: 'type-changed',
          oldType: `${oldSchema.maxItems}`,
          newType: `${newSchema.maxItems}`,
        };
      }
    } else if (oldSchema.maxItems > newSchema.maxItems) {
      if (origin === 'client') {
        breakages.maxItems = {
          reason: 'type-changed',
          oldType: `${oldSchema.maxItems}`,
          newType: `${newSchema.maxItems}`,
        };
      }
    }

    if (
      !oldSchema.uniqueItems &&
      newSchema.uniqueItems &&
      origin === 'client'
    ) {
      breakages.uniqueItems = {
        reason: 'type-changed',
        oldType: `${!!oldSchema.uniqueItems}`,
        newType: `${!!newSchema.uniqueItems}`,
      };
    }

    if ('contains' in newSchema !== 'contains' in oldSchema) {
      if (
        'contains' in newSchema &&
        !('contains' in oldSchema) &&
        origin === 'client'
      ) {
        breakages.contains = {
          reason: 'type-changed',
          oldType: 'no-contains',
          newType: 'contains',
        };
      }
    } else if ('contains' in newSchema) {
      const containsBreakage = diffJSONSchema(
        oldSchema.contains,
        newSchema.contains,
        origin,
      );

      if (containsBreakage) {
        breakages.contains = containsBreakage;
      }
    }

    if (oldSchema.minContains < newSchema.minContains) {
      if (origin === 'client') {
        breakages.minContains = {
          reason: 'type-changed',
          oldType: `${oldSchema.minContains}`,
          newType: `${newSchema.minContains}`,
        };
      }
    } else if (oldSchema.minContains > newSchema.minContains) {
      if (origin === 'server') {
        breakages.minContains = {
          reason: 'type-changed',
          oldType: `${oldSchema.minContains}`,
          newType: `${newSchema.minContains}`,
        };
      }
    }

    if (oldSchema.maxContains < newSchema.maxContains) {
      if (origin === 'server') {
        breakages.maxContains = {
          reason: 'type-changed',
          oldType: `${oldSchema.maxContains}`,
          newType: `${newSchema.maxContains}`,
        };
      }
    } else if (oldSchema.maxContains > newSchema.maxContains) {
      if (origin === 'client') {
        breakages.maxContains = {
          reason: 'type-changed',
          oldType: `${oldSchema.maxContains}`,
          newType: `${newSchema.maxContains}`,
        };
      }
    }
    /**
     * ignoring `additionalItems` since it's not represented in typebox
     */
  } else if (newSchema.type === 'object') {
    // TRecord or TObject or TComposite or TMapped

    if ('properties' in newSchema !== 'properties' in oldSchema) {
      // In theory we can get fancy in this case since Objects are Records with literals as keys
      // but reporting breakage to keep things simpler
      return {
        reason: 'type-changed',
        oldType:
          'properties' in oldSchema ? 'probably-object' : 'probably-record',
        newType:
          'properties' in newSchema ? 'probably-object' : 'probably-record',
      };
    }

    if ('properties' in newSchema) {
      // TObject
      const propertiesBreakages = diffObjectProperties(
        oldSchema.properties,
        newSchema.properties,
        origin,
        oldSchema.required,
        newSchema.required,
      );

      if (Object.keys(propertiesBreakages).length) {
        breakages.properties = {
          reason: 'field-breakage',
          fieldBreakages: propertiesBreakages,
        };
      }
    }

    if ('patternProperties' in newSchema) {
      // TRecord

      const patternPropertiesBreakages = diffObjectProperties(
        oldSchema.patternProperties,
        newSchema.patternProperties,
        origin,
        oldSchema.required,
        newSchema.required,
      );

      if (Object.keys(patternPropertiesBreakages).length) {
        breakages.patternProperties = {
          reason: 'field-breakage',
          fieldBreakages: patternPropertiesBreakages,
        };
      }
    }

    if (
      'additionalProperties' in newSchema ||
      'additionalProperties' in oldSchema
    ) {
      throw new Error('additionalProperties is not supported');
    }

    if ('minProperties' in newSchema || 'minProperties' in oldSchema) {
      throw new Error('minProperties is not supported');
    }

    if ('maxProperties' in newSchema || 'maxProperties' in oldSchema) {
      throw new Error('maxProperties is not supported');
    }
  }

  if (Object.keys(breakages).length) {
    return {
      reason: 'field-breakage',
      fieldBreakages: breakages,
    };
  }

  return null;
}

function diffObjectProperties(
  oldProperties: TProperties,
  newProperties: TProperties,
  origin: 'server' | 'client',
  oldRequiredProperties: Array<string> = [],
  newRequiredProperties: Array<string> = [],
): Record<string, PayloadBreakage> {
  // TRecord
  const allProperties = new Set([
    ...Object.keys(oldProperties),
    ...Object.keys(newProperties),
  ]);

  const breakages: Record<string, PayloadBreakage> = {};

  for (const propertyName of allProperties) {
    const requiredBreakage = diffRequired(
      oldProperties[propertyName],
      newProperties[propertyName],
      origin,
      oldRequiredProperties.includes(propertyName),
      newRequiredProperties.includes(propertyName),
    );

    if (requiredBreakage) {
      breakages[propertyName] = requiredBreakage;
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    } else if (oldProperties[propertyName] && newProperties[propertyName]) {
      const propertyBreakage = diffJSONSchema(
        oldProperties[propertyName],
        newProperties[propertyName],
        origin,
      );

      if (propertyBreakage) {
        breakages[propertyName] = propertyBreakage;
      }
    }
  }

  return breakages;
}

function getReportingType(schema: TAnySchema): string {
  if ('not' in schema) {
    return 'not';
  }

  if ('anyOf' in schema) {
    return 'anyOf';
  }

  if ('allOf' in schema) {
    return 'allOf';
  }

  if ('$ref' in schema) {
    return '$ref';
  }

  if (schema.type && typeof schema.type === 'string') {
    return schema.type;
  }

  throw new Error(
    'Subschema not supported, probably a conditional subschema. Check logs.',
  );
}
