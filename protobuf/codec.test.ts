import { describe, expect, test } from 'vitest';
import type { OpaqueTransportMessage } from '../transport/message';
import { ProtoCodec } from './codec';

describe('ProtoCodec', () => {
  test('roundtrips transport envelopes with raw byte payloads', () => {
    const message: OpaqueTransportMessage = {
      id: 'message-1',
      from: 'client',
      to: 'server',
      seq: 1,
      ack: 2,
      streamId: 'stream-1',
      controlFlags: 3,
      serviceName: 'river.test.TestService',
      procedureName: 'Echo',
      tracing: {
        traceparent: '00-abc-def-01',
        tracestate: '',
      },
      payload: new Uint8Array([1, 2, 3, 4]),
    };

    expect(ProtoCodec.fromBuffer(ProtoCodec.toBuffer(message))).toStrictEqual(
      message,
    );
  });

  test('roundtrips control payloads through msgpack', () => {
    const message: OpaqueTransportMessage = {
      id: 'message-2',
      from: 'client',
      to: 'server',
      seq: 0,
      ack: 0,
      streamId: 'stream-2',
      controlFlags: 4,
      payload: {
        ok: false,
        payload: {
          code: 'INVALID_ARGUMENT',
          message: 'bad request',
          metadata: {
            source: 'test',
          },
          details: [
            {
              typeName: 'river.test.Detail',
              value: new Uint8Array([9, 8, 7]),
            },
          ],
        },
      },
    };

    expect(ProtoCodec.fromBuffer(ProtoCodec.toBuffer(message))).toStrictEqual(
      message,
    );
  });

  test('rejects envelopes without a payload field', () => {
    expect(() => ProtoCodec.fromBuffer(new Uint8Array())).toThrow(
      'missing payload',
    );
  });
});
