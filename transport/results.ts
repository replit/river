import { OpaqueTransportMessage } from './message';

// internal use only, not to be used in public API
type Result<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      reason: string;
    };

export type SendResult = Result<string>;
export type SerializeResult = Result<Uint8Array>;
export type DeserializeResult = Result<OpaqueTransportMessage>;
