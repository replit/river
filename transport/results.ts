import { OpaqueTransportMessage } from './message';

// internal use only, not to be used in public API
type Result<T, Code extends string> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      value: {
        code: Code;
        error: Error;
      };
    };

export type SendErrorCode = 'send_error';
export type SerializeErrorCode = 'serialize_error';
export type DeserializeErrorCode = 'deserialize_error';

export type SendResult = Result<string, SendErrorCode | SerializeErrorCode>;
export type SerializeResult = Result<Uint8Array, SerializeErrorCode>;
export type DeserializeResult = Result<
  OpaqueTransportMessage,
  DeserializeErrorCode
>;
