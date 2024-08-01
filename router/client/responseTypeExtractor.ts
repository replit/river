import { Static } from '@sinclair/typebox';
import { Readable } from '../readable';
import { BaseErrorSchemaType } from '../result/errors';
import { Client } from './client';

/**
 * Retrieve the response type for a procedure, represented as a {@link Result}
 * type.
 * Example:
 * ```
 * type Message = ResponseType<typeof client, 'serviceName', 'procedureName'>
 * ```
 */
export type ResponseType<
  RiverClient,
  ServiceName extends keyof RiverClient,
  ProcedureName extends keyof RiverClient[ServiceName],
  Procedure = RiverClient[ServiceName][ProcedureName],
  Fn extends (...args: never) => unknown = (...args: never) => unknown,
> = RiverClient extends Client<infer __ServiceSchemaMap>
  ? Procedure extends object
    ? Procedure extends object & { rpc: infer RpcFn extends Fn }
      ? Awaited<ReturnType<RpcFn>>
      : Procedure extends object & { upload: infer UploadFn extends Fn }
      ? ReturnType<UploadFn> extends {
          finalize: (...args: never) => Promise<infer UploadOutputMessage>;
        }
        ? UploadOutputMessage
        : never
      : Procedure extends object & { stream: infer StreamFn extends Fn }
      ? ReturnType<StreamFn> extends {
          resReadable: Readable<
            infer StreamOutputMessage,
            Static<BaseErrorSchemaType>
          >;
        }
        ? StreamOutputMessage
        : never
      : Procedure extends object & {
          subscribe: infer SubscriptionFn extends Fn;
        }
      ? Awaited<ReturnType<SubscriptionFn>> extends {
          resReadable: Readable<
            infer SubscriptionOutputMessage,
            Static<BaseErrorSchemaType>
          >;
        }
        ? SubscriptionOutputMessage
        : never
      : never
    : never
  : never;
