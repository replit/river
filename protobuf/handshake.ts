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
  type CustomHandshakeErrorCode,
  type CustomHandshakeErrorCodeSchema,
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

type ValidateHandshake<
  Schema extends DescMessage,
  ParsedMetadata,
  RejectionCodeSchema extends CustomHandshakeErrorCodeSchema,
> = (
  metadata: MessageShape<Schema>,
  previousParsedMetadata?: ParsedMetadata,
  from?: TransportClientId,
) =>
  | ParsedMetadata
  | ProtobufHandshakeFailureCode
  | CustomHandshakeErrorCode<RejectionCodeSchema>
  | Promise<
      | ParsedMetadata
      | ProtobufHandshakeFailureCode
      | CustomHandshakeErrorCode<RejectionCodeSchema>
    >;

/**
 * Create client-side handshake options backed by a protobuf message type.
 */
export function createClientHandshakeOptions<
  Schema extends DescMessage,
  RejectionCodeSchema extends
    CustomHandshakeErrorCodeSchema = CustomHandshakeErrorCodeSchema,
>(
  schema: Schema,
  construct: ConstructHandshake<Schema>,
  eager?: boolean,
  rejectionCodeSchema?: RejectionCodeSchema,
): ClientHandshakeOptions<typeof HandshakeBytesSchema, RejectionCodeSchema> {
  return createTransportClientHandshakeOptions(
    HandshakeBytesSchema,
    async () => {
      const metadata = await construct();

      return encodeMessageBytes(schema, metadata);
    },
    eager,
    rejectionCodeSchema,
  );
}

/**
 * Create server-side handshake options backed by a protobuf message type.
 */
export function createServerHandshakeOptions<
  Schema extends DescMessage,
  ParsedMetadata extends object = object,
  RejectionCodeSchema extends
    CustomHandshakeErrorCodeSchema = CustomHandshakeErrorCodeSchema,
>(
  schema: Schema,
  validate: ValidateHandshake<
    Schema,
    ParsedMetadata,
    NoInfer<RejectionCodeSchema>
  >,
  expiry?: (parsedMetadata: ParsedMetadata) => Date | undefined,
  rejectionCodeSchema?: RejectionCodeSchema,
): ServerHandshakeOptions<
  typeof HandshakeBytesSchema,
  ParsedMetadata,
  RejectionCodeSchema
> {
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
    rejectionCodeSchema,
  );
}
