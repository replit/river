import { Static, TObject } from '@sinclair/typebox';
import { Procedure } from './builder';
import {
  TransportMessage,
  payloadToTransportMessage,
} from '../transport/message';
import { pushable } from 'it-pushable';
import type { Pushable } from 'it-pushable';
import { IsomorphicEnvironment } from '../environment/types';

export function asClientRpc<
  State extends object | unknown,
  I extends TObject,
  O extends TObject,
>(
  environment: IsomorphicEnvironment,
  state: State,
  proc: Procedure<State, 'rpc', I, O>,
) {
  return (msg: Static<I>) =>
    proc
      .handler({ environment, state }, payloadToTransportMessage(msg))
      .then((res) => res.payload);
}

export function asClientStream<
  State extends object | unknown,
  I extends TObject,
  O extends TObject,
>(
  environment: IsomorphicEnvironment,
  state: State,
  proc: Procedure<State, 'stream', I, O>,
): [Pushable<Static<I>>, Pushable<Static<O>>] {
  const i = pushable<Static<I>>({ objectMode: true });
  const o = pushable<Static<O>>({ objectMode: true });

  const ri = pushable<TransportMessage<Static<I>>>({ objectMode: true });
  const ro = pushable<TransportMessage<Static<O>>>({ objectMode: true });

  // wrapping in transport
  (async () => {
    for await (const rawIn of i) {
      ri.push(payloadToTransportMessage(rawIn));
    }
    ri.end();
  })();

  // unwrap from transport
  (async () => {
    for await (const transportRes of ro) {
      o.push(transportRes.payload);
    }
  })();

  // handle
  (async () => {
    await proc.handler({ environment, state }, ri, ro);
    ro.end();
  })();

  return [i, o];
}
