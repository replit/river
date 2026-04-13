import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { MessageInitShape, MessageShape } from '@bufbuild/protobuf';
import {
  decode as msgpackDecode,
  encode as msgpackEncode,
} from '@msgpack/msgpack';
import type { OpaqueTransportMessage } from '../transport/message';
import { Codec } from '../codec/types';
import { TransportEnvelopeSchema } from './gen/transport_pb';

/**
 * A protobuf-native transport envelope codec.
 *
 * The envelope schema is defined in `proto/transport.proto` and generated via
 * `buf generate`. Handler payloads that are already raw protobuf bytes use
 * `payload_bytes`. Non-protobuf payloads (error results, control messages)
 * are msgpack-encoded into `payload_msgpack`.
 */
export const ProtoCodec: Codec = {
  toBuffer(obj) {
    const message = coerceTransportMessage(obj);

    return toBinary(
      TransportEnvelopeSchema,
      create(TransportEnvelopeSchema, toEnvelopeInit(message)),
    ) as Uint8Array;
  },

  fromBuffer(buff: Uint8Array) {
    // WebSocketConnection sets binaryType='arraybuffer', so the buffer
    // arriving here is actually an ArrayBuffer despite the Uint8Array
    // signature on Codec.fromBuffer. The JSON and msgpack codecs happen
    // to tolerate this because TextDecoder.decode() and msgpack.decode()
    // accept ArrayBuffer, but protobuf's fromBinary() requires a real
    // Uint8Array (it uses indexed access). The proper fix is to have the
    // connection hand out Uint8Array in the first place.
    const bytes =
      buff instanceof Uint8Array ? buff : new Uint8Array(buff as ArrayBuffer);

    return fromEnvelope(fromBinary(TransportEnvelopeSchema, bytes));
  },
};

function coerceTransportMessage(obj: object): OpaqueTransportMessage {
  const candidate = obj as Partial<OpaqueTransportMessage>;

  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.from !== 'string' ||
    typeof candidate.to !== 'string' ||
    typeof candidate.seq !== 'number' ||
    typeof candidate.ack !== 'number' ||
    typeof candidate.streamId !== 'string' ||
    typeof candidate.controlFlags !== 'number' ||
    !('payload' in candidate)
  ) {
    throw new Error('ProtoCodec expects an opaque transport message');
  }

  return candidate as OpaqueTransportMessage;
}

function toEnvelopeInit(
  message: OpaqueTransportMessage,
): MessageInitShape<typeof TransportEnvelopeSchema> {
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    seq: message.seq,
    ack: message.ack,
    streamId: message.streamId,
    controlFlags: message.controlFlags,
    serviceName: message.serviceName ?? '',
    procedureName: message.procedureName ?? '',
    tracing: message.tracing
      ? {
          traceparent: message.tracing.traceparent,
          tracestate: message.tracing.tracestate,
        }
      : undefined,
    payloadKind:
      message.payload instanceof Uint8Array
        ? { case: 'payloadBytes', value: message.payload }
        : { case: 'payloadMsgpack', value: msgpackEncode(message.payload) },
  };
}

function fromEnvelope(
  envelope: MessageShape<typeof TransportEnvelopeSchema>,
): OpaqueTransportMessage {
  return {
    id: envelope.id,
    from: envelope.from,
    to: envelope.to,
    seq: envelope.seq,
    ack: envelope.ack,
    streamId: envelope.streamId,
    controlFlags: envelope.controlFlags,
    payload: decodePayloadKind(envelope),
    ...(envelope.serviceName === ''
      ? {}
      : { serviceName: envelope.serviceName }),
    ...(envelope.procedureName === ''
      ? {}
      : { procedureName: envelope.procedureName }),
    ...(envelope.tracing
      ? {
          tracing: {
            traceparent: envelope.tracing.traceparent,
            tracestate: envelope.tracing.tracestate,
          },
        }
      : {}),
  };
}

function decodePayloadKind(
  envelope: MessageShape<typeof TransportEnvelopeSchema>,
): unknown {
  switch (envelope.payloadKind.case) {
    case 'payloadBytes':
      return envelope.payloadKind.value;
    case 'payloadMsgpack':
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      return msgpackDecode(envelope.payloadKind.value);
    default:
      throw new Error('invalid protobuf transport envelope: missing payload');
  }
}
