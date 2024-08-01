import { Static } from '@sinclair/typebox';
import {
  ControlFlags,
  ControlMessagePayloadSchema,
  PartialTransportMessage,
} from '../transport';
import { ResponseBuiltinErrorSchema } from './result/errors';
import { ErrResult } from './result/result';

export function createCloseStreamMessage(
  streamId: string,
): PartialTransportMessage {
  return {
    streamId,
    controlFlags: ControlFlags.StreamClosedBit,
    payload: {
      type: 'CLOSE' as const,
    } satisfies Static<typeof ControlMessagePayloadSchema>,
  };
}

export function createAbortStreamMessage(
  streamId: string,
  payload: ErrResult<Static<typeof ResponseBuiltinErrorSchema>>,
) {
  return {
    streamId,
    controlFlags: ControlFlags.StreamAbortBit,
    payload,
  };
}
