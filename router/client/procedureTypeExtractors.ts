import { Static, TSchema } from '@sinclair/typebox';
import { ResponseBuiltinErrorSchema } from '../result/errors';
import { AnyService } from '../server/services';

/**
 * Helper to get the type definition for the procedure init type of a service.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcInit<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = Static<S['procedures'][ProcName]['requestInit']>;

/**
 * Helper to get the type definition for the procedure input of a service.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcInput<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName] extends { requestData: TSchema }
  ? Static<S['procedures'][ProcName]['requestData']>
  : never;

/**
 * Helper to get the type definition for the procedure output of a service.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcOutput<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = Static<S['procedures'][ProcName]['responseData']>;

/**
 * Helper to get the type definition for the procedure errors of a service.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcErrors<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> =
  | Static<S['procedures'][ProcName]['responseError']>
  | Static<typeof ResponseBuiltinErrorSchema>;

/**
 * Helper to get the type of procedure in a service.
 * @template S - The service.
 * @template ProcName - The name of the procedure.
 */
export type ProcType<
  S extends AnyService,
  ProcName extends keyof S['procedures'],
> = S['procedures'][ProcName]['type'];
