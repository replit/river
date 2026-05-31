import type { Static, TSchema } from 'typebox';
import {
  HandshakeErrorCustomHandlerFatalResponseCodes,
  type TransportClientId,
} from '../transport/message';

type ConstructHandshake<T extends TSchema> = () =>
  | Static<T>
  | Promise<Static<T>>;

type ValidateHandshake<T extends TSchema, ParsedMetadata> = (
  metadata: Static<T>,
  previousParsedMetadata?: ParsedMetadata,
  from?: TransportClientId,
) =>
  | Static<typeof HandshakeErrorCustomHandlerFatalResponseCodes>
  | ParsedMetadata
  | Promise<
      | Static<typeof HandshakeErrorCustomHandlerFatalResponseCodes>
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
   * server-side {@link ParsedMetadata}, or returns a handshake failure code to
   * reject the connection.
   *
   * @param metadata - The metadata sent by the client.
   * @param previousParsedMetadata - The parsed metadata from the previous
   *   connection on this session, if any (e.g. on reconnect).
   * @param from - The client id the peer presented in its handshake. Use it to
   *   confirm the presented id is the one the metadata authorizes before
   *   returning parsed metadata.
   */
  validate: ValidateHandshake<MetadataSchema, ParsedMetadata>;
}

export function createClientHandshakeOptions<
  MetadataSchema extends TSchema = TSchema,
>(
  schema: MetadataSchema,
  construct: ConstructHandshake<MetadataSchema>,
): ClientHandshakeOptions<MetadataSchema> {
  return { schema, construct };
}

export function createServerHandshakeOptions<
  MetadataSchema extends TSchema = TSchema,
  ParsedMetadata extends object = object,
>(
  schema: MetadataSchema,
  validate: ValidateHandshake<MetadataSchema, ParsedMetadata>,
): ServerHandshakeOptions<MetadataSchema, ParsedMetadata> {
  return { schema, validate };
}
