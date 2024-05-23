interface WsEvent extends Event {
  type: string;
  // we don't care about the target
  // because we never use it -- we need to just
  // give it any to suppress the underlying type
  // see: https://www.typescriptlang.org/docs/handbook/type-compatibility.html#any-unknown-object-void-undefined-null-and-never-assignability
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  target: any;
}

interface ErrorEvent extends WsEvent {
  error: unknown;
  message: string;
}

interface CloseEvent extends WsEvent {
  wasClean: boolean;
  code: number;
  reason: string;
}

interface MessageEvent extends WsEvent {
  // same here: we don't know the underlying type of data so we
  // need to just give it any to suppress the underlying type
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export interface WsLikeWithHandlers {
  readonly CONNECTING: 0;
  readonly OPEN: 1;
  readonly CLOSING: 2;
  readonly CLOSED: 3;

  binaryType: string;
  readonly readyState: number;

  onclose(ev: CloseEvent): unknown;
  onmessage(ev: MessageEvent): unknown;
  onopen(ev: WsEvent): unknown;
  onerror(ev: ErrorEvent): unknown;

  send(data: unknown): void;
  close(code?: number, reason?: string): void;
}

// null specific fields
// to my knowledge, this is the only way to get nullable interface methods
// instead of function types
// variance is different for methods and properties
// https://www.typescriptlang.org/docs/handbook/type-compatibility.html#function-parameter-bivariance
type Nullable<T, K extends keyof T> = {
  [_K in keyof T]: _K extends K ? T[_K] | null : T[_K];
};

/**
 * A websocket-like interface that has all we need, this matches
 * "lib.dom.d.ts" and npm's "ws" websocket interfaces.
 */
export type WsLike = Nullable<
  WsLikeWithHandlers,
  'onclose' | 'onmessage' | 'onopen' | 'onerror'
>;
