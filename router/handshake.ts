import { Static, TSchema } from '@sinclair/typebox';
import { ParsedMetadata } from './context';
import { HandshakeErrorCustomHandlerFatalResponseCodes } from '../transport/message';

type ConstructHandshake<T extends TSchema> = () =>
  | Static<T>
  | Promise<Static<T>>;

type ValidateHandshake<T extends TSchema> = (
  metadata: Static<T>,
  previousParsedMetadata?: ParsedMetadata,
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
> {
  /**
   * Schema for the metadata that the server receives from the client
   * during the handshake.
   */
  schema: MetadataSchema;

  /**
   * Parses the {@link HandshakeRequestMetadata} sent by the client, transforming
   * it into {@link ParsedHandshakeMetadata}.
   *
   * May return `false` if the client should be rejected.
   *
   * @param metadata - The metadata sent by the client.
   * @param session - The session that the client would be associated with.
   * @param isReconnect - Whether the client is reconnecting to the session,
   *                      or if this is a new session.
   */
  validate: ValidateHandshake<MetadataSchema>;
}

export function createClientHandshakeOptions<
  MetadataSchema extends TSchema = TSchema,
>(
  schema: MetadataSchema,
  construct: ConstructHandshake<MetadataSchema>,
): ClientHandshakeOptions {
  return { schema, construct };
}

export function createServerHandshakeOptions<
  MetadataSchema extends TSchema = TSchema,
>(
  schema: MetadataSchema,
  validate: ValidateHandshake<MetadataSchema>,
): ServerHandshakeOptions {
  return { schema, validate: validate as ValidateHandshake<TSchema> };
}
