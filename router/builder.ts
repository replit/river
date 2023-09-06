import { TObject, Static } from '@sinclair/typebox';
import { Pushable } from 'it-pushable';

interface Service<
  Name extends string,
  State extends object,
  Procs extends Record<string, unknown>,
> {
  name: Name;
  state: State;
  procedures: Procs;
}

export type Procedure<
  State extends Object,
  I extends TObject,
  O extends TObject,
  SI extends TObject,
  SO extends TObject,
> = {
  input?: I;
  output?: O;
  streamInput?: SI;
  streamOutput?: SO;
  rpcHandler?: (prevState: State, input: Static<I>) => Promise<Static<O>>;
  streamHandler?: (
    prevState: State,
    input: AsyncIterable<Static<SI>>,
  ) => Promise<Pushable<Static<SO>>>;
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
    I extends TObject,
    O extends TObject,
    SI extends TObject,
    SO extends TObject,
    ProcEntry = { [k in ProcName]: Procedure<T['state'], I, O, SI, SO> },
  >(
    procName: ProcName,
    procDef: Procedure<T['state'], I, O, SI, SO>,
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

  static register<Name extends string>(
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
