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
export interface ServiceContext {
  state: object | unknown;
}

/**
 * The {@link ServiceContext} with state. This is what is passed to procedures.
 */
export type ServiceContextWithState<State extends object | unknown> =
  ServiceContext & { state: State };
