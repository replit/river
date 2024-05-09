import { Codec } from '../../codec';
import {
  ClientTransport,
  Connection,
  ServerTransport,
  TransportClientId,
} from '../../transport';
import { ValidCodecs, codecs } from './codec';
import {
  TestTransportOptions,
  ValidTransports,
  transports,
} from './transports';

interface TestMatrixEntry {
  transport: {
    name: string;
    setup: (opts?: TestTransportOptions) => Promise<{
      simulatePhantomDisconnect: () => void;
      getClientTransport: (
        id: TransportClientId,
      ) => ClientTransport<Connection>;
      getServerTransport: () => ServerTransport<Connection>;
      restartServer: () => Promise<void>;
      cleanup: () => Promise<void> | void;
    }>;
  };
  codec: {
    name: string;
    codec: Codec;
  };
}

/**
 * Defines a selector type that pairs a valid transport with a valid codec.
 */
type Selector = [ValidTransports, ValidCodecs];

/**
 * Generates a matrix of test entries for each combination of transport and codec.
 * If a selector is provided, it filters the matrix to only include the specified transport and codec combination.
 *
 * @param selector An optional tuple specifying a transport and codec to filter the matrix.
 * @returns An array of TestMatrixEntry objects representing the combinations of transport and codec.
 */
export const testMatrix = (selector?: Selector): Array<TestMatrixEntry> =>
  transports
    .map((transport) =>
      // If a selector is provided, filter transport + codecs to match the selector; otherwise, use all codecs.
      (selector
        ? codecs.filter(
            (codec) =>
              selector[0] === transport.name && selector[1] === codec.name,
          )
        : codecs
      ).map((codec) => ({
        transport,
        codec,
      })),
    )
    .flat();
