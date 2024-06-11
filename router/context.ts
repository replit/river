import { TransportClientId } from '../transport/message';
import { Connection, Session } from '../transport/session';

/**
 * The context for services/procedures. This is used only on
 * the server.
 *
 * An important detail is that the state prop is always on
 * this interface and it shouldn't be changed, removed, or
 * extended. This prop is for the state of a service.
 *
 * You should use declaration merging to extend this interface
 * with whatever you need. For example, if you need to access
 * a database, you could do:
 *
 * ```ts
 * declare module '@replit/river' {
 *   interface ServiceContext {
 *     db: Database;
 *   }
 * }
 * ```
 */
/* eslint-disable-next-line @typescript-eslint/no-empty-interface */
export interface ServiceContext {}

/**
 * The parsed metadata schema for a service. This is the
 * return value of the {@link ServerHandshakeOptions.validate}
 * if the handshake extension is used.

 * You should use declaration merging to extend this interface
 * with the sanitized metadata.
 *
 * ```ts
 * declare module '@replit/river' {
 *   interface ParsedMetadata {
 *     userId: number;
 *   }
 * }
 * ```
 */
/* eslint-disable-next-line @typescript-eslint/no-empty-interface */
export interface ParsedMetadata {}

/**
 * The {@link ServiceContext} with state. This is what is passed to procedures.
 */
export type ServiceContextWithState<State> = ServiceContext & { state: State };

export type ServiceContextWithTransportInfo<State> = ServiceContext & {
  state: State;
  to: TransportClientId;
  from: TransportClientId;
  streamId: string;
  session: Session<Connection>;
  metadata: ParsedMetadata;
};
