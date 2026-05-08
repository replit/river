import type {
  DescMessage,
  MessageInitShape,
  MessageShape,
} from '@bufbuild/protobuf';
import { type Static, Type } from 'typebox';
import {
  createClientHandshakeOptions as createTransportClientHandshakeOptions,
  createServerHandshakeOptions as createTransportServerHandshakeOptions,
  type ClientHandshakeOptions,
  type ServerHandshakeOptions,
} from '../router/handshake';
import { HandshakeErrorCustomHandlerFatalResponseCodes } from '../transport/message';
import { decodeMessageBytes, encodeMessageBytes } from './shared';

class TUint8Array extends Type.Base<Uint8Array> {
  public readonly type = 'Uint8Array';

  public override Check(value: unknown): value is Uint8Array {
    return value instanceof Uint8Array;
  }

  public override Clone(): TUint8Array {
    return new TUint8Array();
  }
}

const HandshakeBytesSchema = new TUint8Array();

type ProtobufHandshakeFailureCode = Static<
  typeof HandshakeErrorCustomHandlerFatalResponseCodes
>;

type ConstructHandshake<Schema extends DescMessage> = () =>
  | MessageInitShape<Schema>
  | Promise<MessageInitShape<Schema>>;

type ValidateHandshake<Schema extends DescMessage, ParsedMetadata> = (
  metadata: MessageShape<Schema>,
  previousParsedMetadata?: ParsedMetadata,
) =>
  | ParsedMetadata
  | ProtobufHandshakeFailureCode
  | Promise<ParsedMetadata | ProtobufHandshakeFailureCode>;

/**
 * Create client-side handshake options backed by a protobuf message type.
 */
export function createClientHandshakeOptions<Schema extends DescMessage>(
  schema: Schema,
  construct: ConstructHandshake<Schema>,
): ClientHandshakeOptions<typeof HandshakeBytesSchema> {
  return createTransportClientHandshakeOptions(
    HandshakeBytesSchema,
    async () => {
      const metadata = await construct();

      return encodeMessageBytes(schema, metadata);
    },
  );
}

/**
 * Create server-side handshake options backed by a protobuf message type.
 */
export function createServerHandshakeOptions<
  Schema extends DescMessage,
  ParsedMetadata extends object = object,
>(
  schema: Schema,
  validate: ValidateHandshake<Schema, ParsedMetadata>,
): ServerHandshakeOptions<typeof HandshakeBytesSchema, ParsedMetadata> {
  return createTransportServerHandshakeOptions(
    HandshakeBytesSchema,
    async (metadata, previousParsedMetadata) => {
      let decoded;
      try {
        decoded = decodeMessageBytes(schema, metadata);
      } catch {
        return 'REJECTED_BY_CUSTOM_HANDLER' as ProtobufHandshakeFailureCode;
      }

      return await validate(decoded, previousParsedMetadata);
    },
  );
}
