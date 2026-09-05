import { type Static, type TNever, Type } from 'typebox';
import {
  createServiceSchema,
  type InstantiatedServiceSchemaMap,
  Procedure,
  type ProcedureDefinition,
  type ProcedureDefinitionMap,
  type RPCProcedure,
} from '../../router';

const RequestSchema = Type.Object({ value: Type.String() });
const ResponseSchema = Type.Object({ value: Type.String() });

type Equal<Left, Right> = (<T>() => T extends Left ? 1 : 2) extends <
  T,
>() => T extends Right ? 1 : 2
  ? true
  : false;
type Assert<T extends true> = T;

type EchoProcedure = RPCProcedure<
  object,
  object,
  object,
  typeof RequestSchema,
  typeof ResponseSchema,
  TNever
>;

export const echo = Procedure.rpc({
  requestInit: RequestSchema,
  responseData: ResponseSchema,
  async handler({ reqInit }) {
    return { ok: true, payload: reqInit };
  },
});

const definition: ProcedureDefinition<EchoProcedure> = echo;
const constructorResult: typeof echo = definition;
void constructorResult;

export const procedures: ProcedureDefinitionMap<{
  echo: EchoProcedure;
}> = { echo };

type EchoRequest = Static<(typeof procedures)['echo']['requestInit']>;
export type ProcedureNamesAreExact = Assert<
  Equal<keyof typeof procedures, 'echo'>
>;
export type RequestPayloadIsPreserved = Assert<
  Equal<EchoRequest, { value: string }>
>;

const ServiceSchema = createServiceSchema();
export const EchoServiceSchema = ServiceSchema.define(procedures);
const serviceSchemas = { echo: EchoServiceSchema };

export type InstantiatedServices = InstantiatedServiceSchemaMap<
  Record<string, unknown>,
  object,
  typeof serviceSchemas
>;
