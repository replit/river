import { TObject, Static, Type } from '@sinclair/typebox';
import type { Pushable } from 'it-pushable';
import { TransportMessage } from '../transport/message';

export type ValidProcType = 'stream' | 'rpc';
export type ProcListing = Record<string, Procedure<object, ValidProcType, TObject, TObject>>;
export interface Service<
  Name extends string = string,
  State extends object = object,
  // nested record (service listing contains services which have proc listings)
  // this means we lose type specificity on our procedures here so we maintain it by using
  // any on the default type
  Procs extends ProcListing = Record<string, any>,
> {
  name: Name;
  state: State;
  procedures: Procs;
}

export function serializeService(s: Service): object {
  return {
    name: s.name,
    state: s.state,
    procedures: Object.fromEntries(
      Object.entries<Procedure<object, ValidProcType, TObject, TObject>>(s.procedures).map(
        ([procName, procDef]) => [
          procName,
          {
            input: Type.Strict(procDef.input),
            output: Type.Strict(procDef.output),
            type: procDef.type,
          },
        ],
      ),
    ),
  };
}

// extract helpers
export type ProcHandler<
  S extends Service,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName]['handler'];
export type ProcInput<
  S extends Service,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName]['input'];
export type ProcOutput<
  S extends Service,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName]['output'];
export type ProcType<
  S extends Service,
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
    ProcEntry = { [k in ProcName]: Procedure<T['state'], Ty, I, O> },
  >(
    procName: ProcName,
    procDef: Procedure<T['state'], Ty, I, O>,
  ): ServiceBuilder<{
    name: T['name'];
    state: T['state'];
    procedures: {
      // we do this weird keyof thing to simplify the intersection type to something more readable
      // this is basically equivalent to `T['procedures'] & ProcEntry`
      [Key in keyof (T['procedures'] & ProcEntry)]: (T['procedures'] & ProcEntry)[Key];
    };
  }> {
    const newProcedure = { [procName]: procDef } as ProcEntry;
    const procedures = {
      ...this.schema.procedures,
      ...newProcedure,
    } as {
      [Key in keyof (T['procedures'] & ProcEntry)]: (T['procedures'] & ProcEntry)[Key];
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
