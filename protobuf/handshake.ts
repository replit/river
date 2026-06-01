import type {
  DescMessage,
  MessageInitShape,
  MessageShape,
} from '@bufbuild/protobuf';
import { type Static } from 'typebox';
import {
  createClientHandshakeOptions as createTransportClientHandshakeOptions,
  createServerHandshakeOptions as createTransportServerHandshakeOptions,
  type ClientHandshakeOptions,
  type ServerHandshakeOptions,
} from '../router/handshake';
import {
  HandshakeErrorCustomHandlerFatalResponseCodes,
  type TransportClientId,
} from '../transport/message';
import { decodeMessageBytes, encodeMessageBytes } from './shared';
import { Uint8ArrayType } from '../customSchemas';

const HandshakeBytesSchema = Uint8ArrayType();

type ProtobufHandshakeFailureCode = Static<
  typeof HandshakeErrorCustomHandlerFatalResponseCodes
>;

type ConstructHandshake<Schema extends DescMessage> = () =>
  | MessageInitShape<Schema>
  | Promise<MessageInitShape<Schema>>;

type ValidateHandshake<Schema extends DescMessage, ParsedMetadata> = (
  metadata: MessageShape<Schema>,
  previousParsedMetadata?: ParsedMetadata,
  from?: TransportClientId,
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
  eager?: boolean,
): ClientHandshakeOptions<typeof HandshakeBytesSchema> {
  return createTransportClientHandshakeOptions(
    HandshakeBytesSchema,
    async () => {
      const metadata = await construct();

      return encodeMessageBytes(schema, metadata);
    },
    eager,
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
  expiry?: (parsedMetadata: ParsedMetadata) => Date | undefined,
): ServerHandshakeOptions<typeof HandshakeBytesSchema, ParsedMetadata> {
  return createTransportServerHandshakeOptions(
    HandshakeBytesSchema,
    async (metadata, previousParsedMetadata, from) => {
      let decoded;
      try {
        decoded = decodeMessageBytes(schema, metadata);
      } catch {
        return 'REJECTED_BY_CUSTOM_HANDLER' as ProtobufHandshakeFailureCode;
      }

      return await validate(decoded, previousParsedMetadata, from);
    },
    expiry,
  );
}
