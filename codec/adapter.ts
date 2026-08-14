import { Value } from 'typebox/value';
import { Compile } from 'typebox/compile';
// deep import: the transport barrel pulls in the client and server transports,
// which are themselves built on a codec
import {
  type OpaqueTransportMessage,
  OpaqueTransportMessageSchema,
} from '../transport/message';
import { Codec } from './types';
import { DeserializeResult, SerializeResult } from '../transport/results';
import { coerceErrorString } from '../transport/stringifyError';

function interpretedCheck(msg: unknown): msg is OpaqueTransportMessage {
  return Value.Check(OpaqueTransportMessageSchema, msg);
}

type MessageCheck = (msg: unknown) => msg is OpaqueTransportMessage;

let compiled: MessageCheck | null | undefined;

/**
 * A JIT-compiled version of {@link interpretedCheck}, or null where codegen
 * isn't available. Compiling costs a `new Function`, which a strict CSP
 * forbids, so this is opt-in rather than the default -- see
 * {@link CodecMessageAdapterOptions.precompileValidator}.
 */
function compiledCheck(): MessageCheck | null {
  if (compiled === undefined) {
    try {
      const validator = Compile(OpaqueTransportMessageSchema);
      compiled = (msg: unknown): msg is OpaqueTransportMessage =>
        validator.Check(msg);
    } catch {
      compiled = null;
    }
  }

  return compiled;
}

export interface CodecMessageAdapterOptions {
  /**
   * Validate inbound messages with a compiled schema validator rather than
   * walking the schema on every message. Roughly three orders of magnitude
   * faster, and since validation runs per inbound message it otherwise
   * dominates the receive path.
   *
   * Off by default because compiling generates code at runtime, which a strict
   * Content-Security-Policy blocks. Servers turn it on; clients (which may be
   * browsers) don't. If compiling fails anyway, this silently falls back.
   */
  precompileValidator?: boolean;
}

/**
 * Adapts a {@link Codec} to the {@link OpaqueTransportMessage} format,
 * accounting for fallibility of toBuffer and fromBuffer and wrapping
 * it with a Result type.
 */
export class CodecMessageAdapter {
  private readonly check: MessageCheck;

  constructor(
    private readonly codec: Codec,
    options?: CodecMessageAdapterOptions,
  ) {
    this.check =
      (options?.precompileValidator ? compiledCheck() : null) ??
      interpretedCheck;
  }

  toBuffer(msg: OpaqueTransportMessage): SerializeResult {
    try {
      return {
        ok: true,
        value: this.codec.toBuffer(msg),
      };
    } catch (e) {
      return {
        ok: false,
        reason: coerceErrorString(e),
      };
    }
  }

  fromBuffer(buf: Uint8Array): DeserializeResult {
    try {
      const parsedMsg = this.codec.fromBuffer(buf);
      if (!this.check(parsedMsg)) {
        return {
          ok: false,
          reason: 'transport message schema mismatch',
        };
      }

      return {
        ok: true,
        value: parsedMsg,
      };
    } catch (e) {
      return {
        ok: false,
        reason: coerceErrorString(e),
      };
    }
  }
}
