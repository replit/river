import { afterAll, assert, bench, describe } from 'vitest';
import { waitForMessage } from '../util/testHelpers';
import { TestServiceConstructor } from './fixtures/services';
import { createServer } from '../router/server';
import { createClient } from '../router/client';
import { buildServiceDefs } from '../router/defs';
import { transports } from './fixtures/transports';

let smallId = 0;
const dummyPayloadSmall = () => ({
  id: `${smallId++}`,
  from: 'client',
  to: 'SERVER',
  serviceName: 'test',
  procedureName: 'test',
  streamId: 'test',
  controlFlags: 0,
  payload: {
    msg: 'cool',
    n: smallId * 1.5,
  },
});

// give time for v8 to warm up
const BENCH_DURATION = 10_000;
describe('bandwidth', async () => {
  for (const { name, setup } of transports) {
    const { getTransports, cleanup } = await setup();
    afterAll(cleanup);

    const [clientTransport, serverTransport] = getTransports();
    const serviceDefs = buildServiceDefs([TestServiceConstructor()]);
    const server = createServer(serverTransport, serviceDefs);
    const client = createClient<typeof server>(clientTransport);

    bench(
      `${name} -- raw transport send and recv`,
      async () => {
        const msg = dummyPayloadSmall();
        const id = msg.id;
        clientTransport.send(msg);
        await waitForMessage(serverTransport, (msg) => msg.id === id);
        return;
      },
      { time: BENCH_DURATION },
    );

    bench(
      `${name} -- rpc`,
      async () => {
        const result = await client.test.add.rpc({ n: 1 });
        assert(result.ok);
      },
      { time: BENCH_DURATION },
    );

    const [input, output] = await client.test.echo.stream();
    bench(
      `${name} -- stream`,
      async () => {
        input.push({ msg: 'abc', ignore: false });
        const result = await output.next();
        assert(result.value && result.value.ok);
      },
      { time: BENCH_DURATION },
    );
  }
});
