import type {
  DescMessage,
  DescMethod,
  MessageInitShape,
  MessageShape,
} from '@bufbuild/protobuf';
import type { Codec } from '../codec/types';
import { decodeMessageBytes, encodeMessageBytes } from './shared';
import type { AnyCodec, HandlerImpl, SerdeHandler } from './types';

/** A raw handler owns protobuf-body validation; River still validates the envelope. */
const binary: Codec<Uint8Array> = {
  toBuffer: (bytes) => bytes,
  // The returned buffer must contain only the payload, even for Buffer inputs.
  fromBuffer: (bytes) => new Uint8Array(bytes),
};

function message<Schema extends DescMessage>(
  schema: Schema,
): Codec<MessageShape<Schema>, MessageInitShape<Schema>> {
  return {
    toBuffer: (value) => encodeMessageBytes(schema, value),
    fromBuffer: (bytes) => decodeMessageBytes(schema, bytes),
  };
}

export const serde = { binary, message };

interface Serdes<Input extends AnyCodec, Output extends AnyCodec> {
  readonly input: Input;
  readonly output: Output;
}

export function withSerde<
  Method extends DescMethod,
  Input extends AnyCodec,
  Output extends AnyCodec,
  Context extends object,
  State extends object,
  ParsedMetadata extends object,
>(
  method: Method,
  serdes: Serdes<Input, Output>,
  handler: HandlerImpl<
    Method['methodKind'],
    ReturnType<Input['fromBuffer']>,
    Parameters<Output['toBuffer']>[0],
    Context,
    State,
    ParsedMetadata
  >,
): SerdeHandler<Method['methodKind'], Context, State, ParsedMetadata>;
export function withSerde<
  Kind extends DescMethod['methodKind'],
  Input extends AnyCodec,
  Output extends AnyCodec,
  Context extends object,
  State extends object,
  ParsedMetadata extends object,
>(
  serdes: Serdes<Input, Output>,
  handler: HandlerImpl<
    Kind,
    ReturnType<Input['fromBuffer']>,
    Parameters<Output['toBuffer']>[0],
    Context,
    State,
    ParsedMetadata
  >,
): SerdeHandler<Kind, Context, State, ParsedMetadata>;
export function withSerde(
  methodOrSerdes: DescMethod | Serdes<AnyCodec, AnyCodec>,
  serdesOrHandler:
    | Serdes<AnyCodec, AnyCodec>
    | ((...args: Array<never>) => unknown),
  handler?: (...args: Array<never>) => unknown,
) {
  if (typeof serdesOrHandler === 'function') {
    const serdes = methodOrSerdes as Serdes<AnyCodec, AnyCodec>;

    return {
      input: serdes.input,
      output: serdes.output,
      handler: serdesOrHandler,
    };
  }
  const method = methodOrSerdes as DescMethod;
  if (typeof handler !== 'function') {
    throw new TypeError('expected a serde handler');
  }

  return {
    input: serdesOrHandler.input,
    output: serdesOrHandler.output,
    handler,
    methodKind: method.methodKind,
  };
}
