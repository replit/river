import type {
  DescMessage,
  MessageInitShape,
  MessageShape,
} from '@bufbuild/protobuf';
import { Static, Type } from '@sinclair/typebox';
import {
  createClientHandshakeOptions as createTransportClientHandshakeOptions,
  createServerHandshakeOptions as createTransportServerHandshakeOptions,
  type ClientHandshakeOptions,
  type ServerHandshakeOptions,
} from '../router/handshake';
import { HandshakeErrorCustomHandlerFatalResponseCodes } from '../transport/message';
import { decodeMessageBytes, encodeMessageBytes } from './shared';

/**
 * The handshake metadata for protobuf services travels as encoded protobuf bytes
 * over River's existing handshake extension slot.
 */
const HandshakeBytesSchema = Type.Uint8Array();

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
