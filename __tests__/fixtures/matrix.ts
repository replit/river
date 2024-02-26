import { Codec } from '../../codec';
import { codecs } from '../../codec/codec.test';
import {
  ClientTransport,
  Connection,
  ServerTransport,
  TransportClientId,
} from '../../transport';
import { TransportOptions } from '../../transport/transport';
import { transports } from './transports';

type TestMatrixEntry = {
  transport: {
    name: string;
    setup: (opts?: Partial<TransportOptions>) => Promise<{
      getClientTransport: (
        id: TransportClientId,
      ) => ClientTransport<Connection>;
      getServerTransport: () => ServerTransport<Connection>;
      cleanup: () => Promise<void>;
    }>;
  };
  codec: {
    name: string;
    codec: Codec;
  };
};

export const matrix: Array<TestMatrixEntry> = transports.reduce(
  (matrix, transport) => [
    ...matrix,
    ...codecs.map((codec) => ({
      transport,
      codec,
    })),
  ],
  [] as Array<TestMatrixEntry>,
);
