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
  type CustomHandshakeErrorCodeSchemas,
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
  RejectionCodeSchemas extends CustomHandshakeErrorCodeSchemas,
> = (
  metadata: MessageShape<Schema>,
  previousParsedMetadata?: ParsedMetadata,
  from?: TransportClientId,
) =>
  | ParsedMetadata
  | ProtobufHandshakeFailureCode
  | CustomHandshakeErrorCode<RejectionCodeSchemas>
  | Promise<
      | ParsedMetadata
      | ProtobufHandshakeFailureCode
      | CustomHandshakeErrorCode<RejectionCodeSchemas>
    >;

/**
 * Create client-side handshake options backed by a protobuf message type.
 */
export function createClientHandshakeOptions<
  Schema extends DescMessage,
  RejectionCodeSchemas extends CustomHandshakeErrorCodeSchemas = [],
>(
  schema: Schema,
  construct: ConstructHandshake<Schema>,
  eager?: boolean,
  rejectionCodeSchemas?: RejectionCodeSchemas,
): ClientHandshakeOptions<typeof HandshakeBytesSchema, RejectionCodeSchemas> {
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
  RejectionCodeSchemas extends CustomHandshakeErrorCodeSchemas = [],
>(
  schema: Schema,
  validate: ValidateHandshake<
    Schema,
    ParsedMetadata,
    NoInfer<RejectionCodeSchemas>
  >,
  expiry?: (parsedMetadata: ParsedMetadata) => Date | undefined,
  rejectionCodeSchemas?: RejectionCodeSchemas,
): ServerHandshakeOptions<
  typeof HandshakeBytesSchema,
  ParsedMetadata,
  RejectionCodeSchemas
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
