import { TObject, Static } from '@sinclair/typebox';
import { Pushable } from 'it-pushable';
import { TransportMessage } from '../transport/message';

export interface Service<
  Name extends string = string,
  State extends object = object,
  Procs extends Record<string, unknown> = Record<
    string,
    Procedure<object, 'stream' | 'rpc', TObject, TObject>
  >,
> {
  name: Name;
  state: State;
  procedures: Procs;
}

export type Procedure<
  State extends Object,
  Ty extends 'stream' | 'rpc',
  I extends TObject,
  O extends TObject,
> = Ty extends 'rpc'
  ? {
      input: I;
      output: O;
      handler: (
        state: State,
        input: Static<TransportMessage<I>>,
      ) => Promise<Static<TransportMessage<O>>>;
      type: 'rpc';
    }
  : {
      input: I;
      output: O;
      handler: (
        state: State,
        input: AsyncIterable<Static<TransportMessage<I>>>,
        output: Pushable<Static<TransportMessage<O>>>,
      ) => Promise<void>;
      type: 'stream';
    };

export class ServiceBuilder<T extends Service<string, object, Record<string, unknown>>> {
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
    Ty extends 'stream' | 'rpc',
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
