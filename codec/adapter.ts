import { Value } from '@sinclair/typebox/value';
import {
  OpaqueTransportMessage,
  OpaqueTransportMessageSchema,
} from '../transport';
import { Codec } from './types';
import { DeserializeResult, SerializeResult } from '../transport/results';
import { coerceErrorString } from '../transport/stringifyError';

export class CodecMessageAdapter {
  constructor(private readonly codec: Codec) {}

  toBuffer(msg: OpaqueTransportMessage): SerializeResult {
    try {
      return {
        ok: true,
        value: this.codec.toBuffer(msg),
      };
    } catch (e) {
      const error =
        e instanceof Error
          ? e
          : new Error(`serialize error: ${coerceErrorString(e)}`);

      return {
        ok: false,
        value: {
          code: 'serialize_error',
          error,
        },
      };
    }
  }

  fromBuffer(buf: Uint8Array): DeserializeResult {
    try {
      const parsedMsg = this.codec.fromBuffer(buf);
      if (!Value.Check(OpaqueTransportMessageSchema, parsedMsg)) {
        return {
          ok: false,
          value: {
            code: 'deserialize_error',
            error: new Error('transport message schema mismatch'),
          },
        };
      }

      return {
        ok: true,
        value: parsedMsg,
      };
    } catch (e) {
      const error =
        e instanceof Error
          ? e
          : new Error(`deserialize error: ${coerceErrorString(e)}`);

      return {
        ok: false,
        value: {
          code: 'deserialize_error',
          error,
        },
      };
    }
  }
}
