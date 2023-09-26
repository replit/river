/**
 * The environment for services/procedures. This is used only on
 * the server.
 *
 * You should use declaration merging to extend this interface
 * with whatever you need. For example, if you need to access
 * a database, you can do:
 * ```ts
 * declare module '@replit/river' {
 *   interface IsomorphicEnvironment {
 *     db: Database;
 *   }
 * }
 * ```
 */
export interface IsomorphicEnvironment {}
