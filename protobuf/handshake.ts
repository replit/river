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
  type LiteralErrorCode,
  type LiteralErrorCodeSchemas,
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
  ApplicationErrorCode extends string = never,
> = (
  metadata: MessageShape<Schema>,
  previousParsedMetadata?: ParsedMetadata,
  from?: TransportClientId,
) =>
  | ParsedMetadata
  | ProtobufHandshakeFailureCode
  | LiteralErrorCode<ApplicationErrorCode>
  | Promise<
      | ParsedMetadata
      | ProtobufHandshakeFailureCode
      | LiteralErrorCode<ApplicationErrorCode>
    >;

/**
 * Create client-side handshake options backed by a protobuf message type.
 */
export function createClientHandshakeOptions<
  Schema extends DescMessage,
  const ApplicationErrorCode extends string = never,
>(
  schema: Schema,
  construct: ConstructHandshake<Schema>,
  eager?: boolean,
  rejectionCodeSchemas?: LiteralErrorCodeSchemas<ApplicationErrorCode>,
): ClientHandshakeOptions<typeof HandshakeBytesSchema, ApplicationErrorCode> {
  return createTransportClientHandshakeOptions(
    HandshakeBytesSchema,
    async () => {
      const metadata = await construct();

      return encodeMessageBytes(schema, metadata);
    },
    eager,
    rejectionCodeSchemas,
  );
}

/**
 * Create server-side handshake options backed by a protobuf message type.
 */
export function createServerHandshakeOptions<
  Schema extends DescMessage,
  ParsedMetadata extends object = object,
  const ApplicationErrorCode extends string = never,
>(
  schema: Schema,
  validate: ValidateHandshake<
    Schema,
    ParsedMetadata,
    NoInfer<ApplicationErrorCode>
  >,
  expiry?: (parsedMetadata: ParsedMetadata) => Date | undefined,
  rejectionCodeSchemas?: LiteralErrorCodeSchemas<ApplicationErrorCode>,
): ServerHandshakeOptions<
  typeof HandshakeBytesSchema,
  ParsedMetadata,
  ApplicationErrorCode
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
    rejectionCodeSchemas,
  );
}
