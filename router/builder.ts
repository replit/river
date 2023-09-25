import { TObject, Static, Type } from '@sinclair/typebox';
import type { Pushable } from 'it-pushable';
import { TransportMessage } from '../transport/message';

export type ValidProcType = 'stream' | 'rpc';
export type ProcListing = Record<
  string,
  Procedure<object, ValidProcType, TObject, TObject>
>;
export interface Service<
  Name extends string,
  State extends object,
  // nested record (service listing contains services which have proc listings)
  // this means we lose type specificity on our procedures here so we maintain it by using
  // any on the default type
  Procs extends ProcListing,
> {
  name: Name;
  state: State;
  procedures: Procs;
}
export type AnyService = Service<string, object, any>;

export function serializeService(s: AnyService): object {
  return {
    name: s.name,
    state: s.state,
    procedures: Object.fromEntries(
      Object.entries<Procedure<object, ValidProcType, TObject, TObject>>(
        s.procedures,
      ).map(([procName, procDef]) => [
        procName,
        {
          input: Type.Strict(procDef.input),
          output: Type.Strict(procDef.output),
          type: procDef.type,
        },
      ]),
    ),
  };
}

// extract helpers
export type ProcHandler<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName]['handler'];
export type ProcInput<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName]['input'];
export type ProcOutput<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName]['output'];
export type ProcType<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName]['type'];

export type Procedure<
  State extends object | unknown,
  Ty extends ValidProcType,
  I extends TObject,
  O extends TObject,
> = Ty extends 'rpc'
  ? {
      input: I;
      output: O;
      handler: (
        state: State,
        input: TransportMessage<Static<I>>,
      ) => Promise<TransportMessage<Static<O>>>;
      type: Ty;
    }
  : {
      input: I;
      output: O;
      handler: (
        state: State,
        input: AsyncIterable<TransportMessage<Static<I>>>,
        output: Pushable<TransportMessage<Static<O>>>,
      ) => Promise<void>;
      type: Ty;
    };

export class ServiceBuilder<T extends Service<string, object, ProcListing>> {
  private readonly schema: T;
  private constructor(schema: T) {
    this.schema = schema;
  }

  finalize(): T {
    return this.schema;
  }

  initialState<InitState extends T['state']>(
    state: InitState,
  ): ServiceBuilder<{
    name: T['name'];
    state: InitState;
    procedures: T['procedures'];
  }> {
    return new ServiceBuilder({
      ...this.schema,
      state,
    });
  }

  defineProcedure<
    ProcName extends string,
    Ty extends ValidProcType,
    I extends TObject,
    O extends TObject,
  >(
    procName: ProcName,
    procDef: Procedure<T['state'], Ty, I, O>,
  ): ServiceBuilder<{
    name: T['name'];
    state: T['state'];
    procedures: T['procedures'] & {
      [k in ProcName]: Procedure<T['state'], Ty, I, O>;
    };
  }> {
    type ProcListing = { [k in ProcName]: Procedure<T['state'], Ty, I, O> };
    const newProcedure = { [procName]: procDef } as ProcListing;
    const procedures = {
      ...this.schema.procedures,
      ...newProcedure,
    } as {
      [Key in keyof (T['procedures'] & ProcListing)]: (T['procedures'] &
        ProcListing)[Key];
    };
    return new ServiceBuilder({
      ...this.schema,
      procedures,
    });
  }

  static create<Name extends string>(
    name: Name,
  ): ServiceBuilder<{
    name: Name;
    state: {};
    procedures: {};
  }> {
    return new ServiceBuilder({
      name,
      state: {},
      procedures: {},
    });
  }
}
