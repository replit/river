import type { Static, TSchema } from 'typebox';
import {
  HandshakeErrorCustomHandlerFatalResponseCodes,
  HandshakeRejectionDetailsSchema,
  type TransportClientId,
} from '../transport/message';

const handshakeRejectionBrand: unique symbol = Symbol('handshakeRejection');

export type HandshakeRejectionDetails = Static<
  typeof HandshakeRejectionDetailsSchema
>;

export interface HandshakeRejection {
  readonly [handshakeRejectionBrand]: true;
  responseCode: Static<typeof HandshakeErrorCustomHandlerFatalResponseCodes>;
  details: HandshakeRejectionDetails;
}

export function rejectHandshake(
  details: HandshakeRejectionDetails,
  responseCode: Static<
    typeof HandshakeErrorCustomHandlerFatalResponseCodes
  > = 'REJECTED_BY_CUSTOM_HANDLER',
): HandshakeRejection {
  return {
    [handshakeRejectionBrand]: true,
    responseCode,
    details,
  };
}

export function isHandshakeRejection(
  value: unknown,
): value is HandshakeRejection {
  return (
    typeof value === 'object' &&
    value !== null &&
    handshakeRejectionBrand in value
  );
}

type ConstructHandshake<T extends TSchema> = () =>
  | Static<T>
  | Promise<Static<T>>;

type ValidateHandshake<T extends TSchema, ParsedMetadata> = (
  metadata: Static<T>,
  previousParsedMetadata?: ParsedMetadata,
  from?: TransportClientId,
) =>
  | Static<typeof HandshakeErrorCustomHandlerFatalResponseCodes>
  | HandshakeRejection
  | ParsedMetadata
  | Promise<
      | Static<typeof HandshakeErrorCustomHandlerFatalResponseCodes>
      | HandshakeRejection
      | ParsedMetadata
    >;

export interface ClientHandshakeOptions<
  MetadataSchema extends TSchema = TSchema,
> {
  /**
   * Schema for the metadata that the client sends to the server
   * during the handshake.
   */
  schema: MetadataSchema;

  /**
   * Gets the {@link HandshakeRequestMetadata} to send to the server.
   */
  construct: ConstructHandshake<MetadataSchema>;

  /**
   * When true, the client constructs handshake metadata as soon as it begins
   * dialing, so a slow {@link construct} (e.g. fetching a fresh token) overlaps
   * establishing the connection rather than running after it. The trade-off is
   * that `construct` then runs on every connection attempt, including ones that
   * never connect, so leave it unset when constructing is expensive or
   * rate-limited.
   */
  eager?: boolean;
}

export interface ServerHandshakeOptions<
  MetadataSchema extends TSchema = TSchema,
  ParsedMetadata extends object = object,
> {
  /**
   * Schema for the metadata that the server receives from the client
   * during the handshake.
   */
  schema: MetadataSchema;

  /**
   * Parses the metadata sent by the client during the handshake into the
   * server-side {@link ParsedMetadata}, or returns a handshake failure code or
   * {@link HandshakeRejection} to reject the connection.
   *
   * @param metadata - The metadata sent by the client.
   * @param previousParsedMetadata - The parsed metadata from the previous
   *   connection on this session, if any (e.g. on reconnect).
   * @param from - The client id the peer presented in its handshake. Use it to
   *   confirm the presented id is the one the metadata authorizes before
   *   returning parsed metadata.
   */
  validate: ValidateHandshake<MetadataSchema, ParsedMetadata>;

  /**
   * When the credential expires (or undefined if it never does). The server
   * re-handshakes one `handshakeTimeoutMs` beforehand — re-validating fresh
   * metadata and live-replacing the stored value — so the session never serves
   * past expiry: a refresh lands first, or an unanswered re-handshake tears the
   * session down by then. Re-evaluated on every (re)validation.
   *
   * Scheduling only — it does not gate requests, so reject already-expired
   * credentials in {@link validate} or against the live `ctx.metadata`.
   */
  expiry?: (parsedMetadata: ParsedMetadata) => Date | undefined;
}

export function createClientHandshakeOptions<
  MetadataSchema extends TSchema = TSchema,
>(
  schema: MetadataSchema,
  construct: ConstructHandshake<MetadataSchema>,
  eager?: boolean,
): ClientHandshakeOptions<MetadataSchema> {
  return { schema, construct, eager };
}

export function createServerHandshakeOptions<
  MetadataSchema extends TSchema = TSchema,
  ParsedMetadata extends object = object,
>(
  schema: MetadataSchema,
  validate: ValidateHandshake<MetadataSchema, ParsedMetadata>,
  expiry?: (parsedMetadata: ParsedMetadata) => Date | undefined,
): ServerHandshakeOptions<MetadataSchema, ParsedMetadata> {
  return { schema, validate, expiry };
}
