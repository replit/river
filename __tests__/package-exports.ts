import { SerdeHandler } from '../dist/protobuf/index.js';

export type UnarySerdeHandler = SerdeHandler<'unary', object, object, object>;

// @ts-expect-error SerdeHandler must not advertise a runtime value.
export type SerdeHandlerValue = typeof SerdeHandler;
