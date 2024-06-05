import type {
  SerializedServerSchema,
  SerializedServiceSchema,
  SerializedProcedureSchema,
  PayloadType,
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
  | { reason: 'type-changed'; oldType: string; newType: string }
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

  const inputBreakage = diffPayload(
    oldProcedure.input,
    newProcedure.input,
    'client',
  );
  const initBreakage = diffPayload(
    oldProcedure.init,
    newProcedure.init,
    'client',
  );
  const outputBreakage = diffPayload(
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

function diffPayload(
  oldPayload: PayloadType | undefined,
  newPayload: PayloadType | undefined,
  origin: 'server' | 'client',
  oldRequired?: boolean,
  newRequired?: boolean,
): PayloadBreakage | null {
  if (!newPayload && !oldPayload) {
    return null;
  }
  // old server will send this field, new client will not
  if (!newPayload) {
    // This is only okay if the the field was optional and the origin is the server.
    if (!oldRequired && origin == 'server') {
      return null;
    }
    return { reason: 'removed-required' };
  }
  if (!oldPayload) {
    if (newRequired && origin === 'client') {
      return { reason: 'new-required' };
    }
    // New service, perfectly fine.
    return null;
  }

  if (oldPayload.type !== newPayload.type) {
    return {
      reason: 'type-changed',
      oldType: oldPayload.type,
      newType: newPayload.type,
    };
  }

  if (newPayload.type === 'object') {
    const allProperties = new Set([
      ...Object.keys(oldPayload.properties),
      ...Object.keys(newPayload.properties),
    ]);

    const breakages: Record<string, PayloadBreakage> = {};
    for (const propertyName of allProperties) {
      const propertyBreakage = diffPayload(
        oldPayload.properties[propertyName],
        newPayload.properties[propertyName],
        origin,
        (oldPayload.required ?? []).includes(propertyName),
        (newPayload.required ?? []).includes(propertyName),
      );
      if (propertyBreakage) {
        breakages[propertyName] = propertyBreakage;
      }
    }
    if (Object.keys(breakages).length) {
      return {
        reason: 'field-breakage',
        fieldBreakages: breakages,
      };
    }
  }

  return null;
}
