import { TelemetryInfo } from '../tracing';
import { MessageMetadata } from '../logging';
import { generateId } from './id';

/**
 * A connection is the actual raw underlying transport connection.
 * It's responsible for dispatching to/from the actual connection itself
 * This should be instantiated as soon as the client/server has a connection
 * It's tied to the lifecycle of the underlying transport connection (i.e. if the WS drops, this connection should be deleted)
 */
export abstract class Connection {
  id: string;
  telemetry?: TelemetryInfo;

  constructor() {
    this.id = `conn-${generateId()}`; // for debugging, no collision safety needed
  }

  get loggingMetadata(): MessageMetadata {
    const metadata: MessageMetadata = { connId: this.id };

    if (this.telemetry?.span.isRecording()) {
      const spanContext = this.telemetry.span.spanContext();
      metadata.telemetry = {
        traceId: spanContext.traceId,
        spanId: spanContext.spanId,
      };
    }

    return metadata;
  }

  dataListener?: (msg: Uint8Array) => void;
  closeListener?: () => void;
  errorListener?: (err: Error) => void;

  onData(msg: Uint8Array) {
    this.dataListener?.(msg);
  }

  onError(err: Error) {
    this.errorListener?.(err);
  }

  onClose() {
    this.closeListener?.();
    this.telemetry?.span.end();
  }

  /**
   * Set the callback for when a message is received.
   * @param cb The message handler callback.
   */
  setDataListener(cb: (msg: Uint8Array) => void) {
    this.dataListener = cb;
  }

  removeDataListener() {
    this.dataListener = undefined;
  }

  /**
   * Set the callback for when the connection is closed.
   * This should also be called if an error happens and after notifying the error listener.
   * @param cb The callback to call when the connection is closed.
   */
  setCloseListener(cb: () => void): void {
    this.closeListener = cb;
  }

  removeCloseListener(): void {
    this.closeListener = undefined;
  }

  /**
   * Set the callback for when an error is received.
   * This should only be used for logging errors, all cleanup
   * should be delegated to setCloseListener.
   *
   * The implementer should take care such that the implemented
   * connection will call both the close and error callbacks
   * on an error.
   *
   * @param cb The callback to call when an error is received.
   */
  setErrorListener(cb: (err: Error) => void): void {
    this.errorListener = cb;
  }

  removeErrorListener(): void {
    this.errorListener = undefined;
  }

  /**
   * Sends a message over the connection.
   * @param msg The message to send.
   * @returns true if the message was sent, false otherwise.
   */
  abstract send(msg: Uint8Array): boolean;

  /**
   * Closes the connection.
   */
  abstract close(): void;
}
