import { Duplex } from 'node:stream';
import { assert } from 'vitest';

const kCallback = Symbol('Callback');
const kInitOtherSide = Symbol('InitOtherSide');

// yoinked from https://github.com/nodejs/node/blob/c3a7b29e56a5ada6327ebb622ba746d022685742/lib/internal/streams/duplexpair.js#L55
// but with types
class DuplexSide extends Duplex {
  private otherSide: DuplexSide | null;
  private [kCallback]: (() => void) | null;

  constructor() {
    super();
    this[kCallback] = null;
    this.otherSide = null;
  }

  [kInitOtherSide](otherSide: DuplexSide) {
    if (this.otherSide === null) {
      this.otherSide = otherSide;
    }
  }

  _read() {
    const callback = this[kCallback];
    if (callback) {
      this[kCallback] = null;
      callback();
    }
  }

  _write(
    chunk: Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    assert(this.otherSide !== null);
    assert(this.otherSide[kCallback] === null);
    if (chunk.length === 0) {
      process.nextTick(callback);
    } else {
      this.otherSide.push(chunk);
      this.otherSide[kCallback] = callback;
    }
  }

  _final(callback: (error?: Error | null) => void) {
    this.otherSide?.on('end', callback);
    this.otherSide?.push(null);
  }
}

export function duplexPair(): [DuplexSide, DuplexSide] {
  const side0 = new DuplexSide();
  const side1 = new DuplexSide();
  side0[kInitOtherSide](side1);
  side1[kInitOtherSide](side0);

  return [side0, side1];
}
