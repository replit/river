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
  | ApplicationErrorCode
  | Promise<
      ParsedMetadata | ProtobufHandshakeFailureCode | ApplicationErrorCode
    >;

/**
 * Create client-side handshake options backed by a protobuf message type.
 */
export function createClientHandshakeOptions<
  Schema extends DescMessage,
  ApplicationErrorCode extends string = never,
>(
  schema: Schema,
  construct: ConstructHandshake<Schema>,
  eager?: boolean,
  rejectionCodes?: ReadonlyArray<ApplicationErrorCode>,
): ClientHandshakeOptions<typeof HandshakeBytesSchema, ApplicationErrorCode> {
  return createTransportClientHandshakeOptions(
    HandshakeBytesSchema,
    async () => {
      const metadata = await construct();

      return encodeMessageBytes(schema, metadata);
    },
    eager,
    rejectionCodes,
  );
}

/**
 * Create server-side handshake options backed by a protobuf message type.
 */
export function createServerHandshakeOptions<
  Schema extends DescMessage,
  ParsedMetadata extends object = object,
  ApplicationErrorCode extends string = never,
>(
  schema: Schema,
  validate: ValidateHandshake<
    Schema,
    ParsedMetadata,
    NoInfer<ApplicationErrorCode>
  >,
  expiry?: (parsedMetadata: ParsedMetadata) => Date | undefined,
  rejectionCodes?: ReadonlyArray<ApplicationErrorCode>,
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
    rejectionCodes,
  );
}
