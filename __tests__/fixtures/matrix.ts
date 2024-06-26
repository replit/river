import { Codec } from '../../codec';
import { ValidCodecs, codecs } from './codec';
import {
  TransportMatrixEntry,
  ValidTransports,
  transports,
} from './transports';

interface TestMatrixEntry {
  transport: TransportMatrixEntry;
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
  // If a selector is provided, filter transports to match the selector
  (selector
    ? transports.filter((transport) => selector[0] === transport.name)
    : transports
  )
    .map((transport) =>
      codecs.map((codec) => ({
        transport,
        codec,
      })),
    )
    .flat();
