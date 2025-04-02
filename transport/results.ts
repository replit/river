import { OpaqueTransportMessage } from './message';

// internal use only, not to be used in public API
type SessionApiResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      reason: string;
    };

export type SendResult = SessionApiResult<string>;
export type SendBufferResult = SessionApiResult<undefined>;
export type SerializeResult = SessionApiResult<Uint8Array>;
export type DeserializeResult = SessionApiResult<OpaqueTransportMessage>;
