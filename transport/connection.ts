import { TelemetryInfo } from '../tracing';
import { MessageMetadata } from '../logging';
import { generateId } from './id';

/**
 * A connection is the actual raw underlying transport connection.
 * It’s responsible for dispatching to/from the actual connection itself
 * This should be instantiated as soon as the client/server has a connection
 * It’s tied to the lifecycle of the underlying transport connection (i.e. if the WS drops, this connection should be deleted)
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

  // can't use event emitter because we need this to work in both node + browser
  private _dataListeners = new Set<(msg: Uint8Array) => void>();
  private _closeListeners = new Set<() => void>();
  private _errorListeners = new Set<(err: Error) => void>();

  get dataListeners() {
    return [...this._dataListeners];
  }

  get closeListeners() {
    return [...this._closeListeners];
  }

  get errorListeners() {
    return [...this._errorListeners];
  }

  /**
   * Handle adding a callback for when a message is received.
   * @param msg The message that was received.
   */
  addDataListener(cb: (msg: Uint8Array) => void) {
    this._dataListeners.add(cb);
  }

  removeDataListener(cb: (msg: Uint8Array) => void): void {
    this._dataListeners.delete(cb);
  }

  /**
   * Handle adding a callback for when the connection is closed.
   * This should also be called if an error happens and after notifying all the error listeners.
   * @param cb The callback to call when the connection is closed.
   */
  addCloseListener(cb: () => void): void {
    this._closeListeners.add(cb);
  }

  removeCloseListener(cb: () => void): void {
    this._closeListeners.delete(cb);
  }

  /**
   * Handle adding a callback for when an error is received.
   * This should only be used for this.logging errors, all cleanup
   * should be delegated to addCloseListener.
   *
   * The implementer should take care such that the implemented
   * connection will call both the close and error callbacks
   * on an error.
   *
   * @param cb The callback to call when an error is received.
   */
  addErrorListener(cb: (err: Error) => void): void {
    this._errorListeners.add(cb);
  }

  removeErrorListener(cb: (err: Error) => void): void {
    this._errorListeners.delete(cb);
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
