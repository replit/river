import { afterAll, assert, bench, describe } from 'vitest';
import { waitForMessage } from '../util/testHelpers';
import { TestServiceSchema } from './fixtures/services';
import { createServer } from '../router/server';
import { createClient } from '../router/client';
import { transports } from './fixtures/transports';
import { nanoid } from 'nanoid';

let n = 0;
const dummyPayloadSmall = () => ({
  streamId: 'test',
  controlFlags: 0,
  payload: {
    msg: 'cool',
    n: n++,
  },
});

// give time for v8 to warm up
const BENCH_DURATION = 10_000;
describe('bandwidth', async () => {
  for (const { name, setup } of transports) {
    const { getClientTransport, getServerTransport, cleanup } = await setup();
    afterAll(cleanup);

    const serverTransport = getServerTransport();
    const clientTransport = getClientTransport('client');
    clientTransport.connect(serverTransport.clientId);

    const services = { test: TestServiceSchema };
    createServer(serverTransport, services);
    const client = createClient<typeof services>(
      clientTransport,
      serverTransport.clientId,
    );

    bench(
      `${name} -- raw transport send and recv`,
      async () => {
        const msg = dummyPayloadSmall();
        const id = clientTransport.send(serverTransport.clientId, msg);
        await waitForMessage(serverTransport, (msg) => msg.id === id);
        return;
      },
      { time: BENCH_DURATION },
    );

    bench(
      `${name} -- rpc`,
      async () => {
        const result = await client.test.add.rpc({ n: Math.random() });
        assert(result.ok);
      },
      { time: BENCH_DURATION },
    );

    const [input, output] = await client.test.echo.stream();
    bench(
      `${name} -- stream`,
      async () => {
        input.push({ msg: nanoid(), ignore: false });
        const result = await output.next();
        assert(result.value.ok);
      },
      { time: BENCH_DURATION },
    );
  }
});
