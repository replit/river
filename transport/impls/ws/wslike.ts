/**
 * A websocket-like interface that has all we need, this matches
 * "lib.dom.d.ts" and npm's "ws" websocket interfaces.
 *
 * This makes things a little weird within the ws module but it's
 * the only way to avoid casting and type errors.
 */
export interface WSLike<
  CloseEvent extends { code: number; reason: string; wasClean: boolean } = {
    code: number;
    reason: string;
    wasClean: boolean;
  },
  MessageEvent extends { data: unknown } = { data: unknown },
  ErrorEvent extends object = object,
  OpenEvent extends object = object,
  BinaryType extends string = string,
> {
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;

  binaryType: BinaryType;

  readonly readyState: number;

  onclose: ((ev: CloseEvent) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onopen: ((ev: OpenEvent) => unknown) | null;
  onerror: ((ev: ErrorEvent) => unknown) | null;

  send(data: unknown): void;
  close(code?: number, reason?: string): void;
}
