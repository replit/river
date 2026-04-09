import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type {
  DescMessage,
  DescMethod,
  MessageInitShape,
  MessageShape,
} from '@bufbuild/protobuf';
import type { ValidProcType } from '../router';

/**
 * Empty protobuf payload used to open client-streaming and bidi streams without
 * inventing a separate request-init concept.
 */
export const EMPTY_PROTO_BYTES = new Uint8Array(0);

/**
 * Convert protobuf method kinds into River procedure kinds for telemetry and
 * stream lifecycle behavior.
 */
export function methodKindToProcType(
  methodKind: DescMethod['methodKind'],
): ValidProcType {
  switch (methodKind) {
    case 'unary':
      return 'rpc';
    case 'server_streaming':
      return 'subscription';
    case 'client_streaming':
      return 'upload';
    case 'bidi_streaming':
      return 'stream';
  }
}

/**
 * A stable registration key for a protobuf method.
 */
export function methodKey(serviceName: string, methodName: string): string {
  return `${serviceName}/${methodName}`;
}

/**
 * Encode a protobuf message init shape into wire bytes.
 */
export function encodeMessageBytes<Schema extends DescMessage>(
  schema: Schema,
  message: MessageInitShape<Schema>,
): Uint8Array {
  return toBinary(schema, create(schema, message)) as Uint8Array;
}

/**
 * Decode protobuf wire bytes into a typed message shape.
 */
export function decodeMessageBytes<Schema extends DescMessage>(
  schema: Schema,
  payload: Uint8Array,
): MessageShape<Schema> {
  return fromBinary(schema, payload) as MessageShape<Schema>;
}
