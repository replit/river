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
  type ApplicationErrorCode,
  type ApplicationErrorCodeSchemas,
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
  RejectionCodeSchemas extends ApplicationErrorCodeSchemas = [],
> = (
  metadata: MessageShape<Schema>,
  previousParsedMetadata?: ParsedMetadata,
  from?: TransportClientId,
) =>
  | ParsedMetadata
  | ProtobufHandshakeFailureCode
  | ApplicationErrorCode<RejectionCodeSchemas>
  | Promise<
      | ParsedMetadata
      | ProtobufHandshakeFailureCode
      | ApplicationErrorCode<RejectionCodeSchemas>
    >;

/**
 * Create client-side handshake options backed by a protobuf message type.
 */
export function createClientHandshakeOptions<
  Schema extends DescMessage,
  RejectionCodeSchemas extends ApplicationErrorCodeSchemas = [],
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
  RejectionCodeSchemas extends ApplicationErrorCodeSchemas = [],
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
