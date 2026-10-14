import { describe, expect, test, vi } from 'vitest';
import { BinaryCodec, NaiveJsonCodec } from '../codec';
import {
  createClient,
  createProtoService,
  createServer,
  Ok,
  ProtoCodec,
} from '../protobuf';
import { cleanupTransports, waitFor } from '../testUtil/fixtures/cleanup';
import { TestService } from '../testUtil/fixtures/protobuf';
import { transports } from '../testUtil/fixtures/transports';
import { isAck } from '../transport/message';

const matrix = transports.flatMap((transport) =>
  [
    { name: 'naive', codec: NaiveJsonCodec },
    { name: 'binary', codec: BinaryCodec },
    { name: 'proto', codec: ProtoCodec },
  ].map((codec) => ({ transport, codec })),
);

describe.each(matrix)(
  'protobuf stream isolation ($transport.name, $codec.name)',
  ({ transport, codec }) => {
    test('request and response writers use their own stream watermarks', async () => {
      vi.useRealTimers();
      const options = {
        codec: codec.codec,
        sendBufferHighWaterMark: 4,
        streamSendBufferHighWaterMark: 4,
        receiverAck: { maxMessages: 3, maxDelayMs: 20 },
        heartbeatIntervalMs: 30_000,
        sessionDisconnectGraceMs: 90_000,
      };
      const setup = await transport.setup({ client: options, server: options });
      const clientTransport = setup.getClientTransport('client');
      const serverTransport = setup.getServerTransport();
      const violations: Array<string> = [];
      for (const transport of [clientTransport, serverTransport]) {
        transport.bindLogger((text, meta) => {
          if (meta?.tags?.includes('invariant-violation')) {
            violations.push(text);
          }
        }, 'debug');
      }
      const responsePressure: Array<Array<boolean>> = [];
      const service = createProtoService().define(TestService, {
        countUp: ({ request, resWritable }) => {
          const results: Array<boolean> = [];
          for (let value = 1; value <= request.limit; value++) {
            results.push(resWritable.write(Ok({ value })));
          }
          responsePressure.push(results);
          resWritable.close();
        },
        sum: async ({ reqReadable }) => {
          let total = 0;
          for await (const result of reqReadable) {
            if (result.ok) total += result.payload.value;
          }

          return Ok({ total });
        },
      });
      createServer(serverTransport, [service]);
      const client = createClient(
        TestService,
        clientTransport,
        serverTransport.clientId,
      );
      try {
        const heavyRequest = client.sum();
        for (let i = 0; i < 6; i++)
          heavyRequest.reqWritable.write({ value: i });
        const quietRequest = client.sum();
        expect(quietRequest.reqWritable.write({ value: 1 })).toBe(true);
        heavyRequest.reqWritable.close();
        quietRequest.reqWritable.close();
        expect(await heavyRequest.finalize()).toMatchObject({
          ok: true,
          payload: { total: 15 },
        });
        expect(await quietRequest.finalize()).toMatchObject({
          ok: true,
          payload: { total: 1 },
        });

        const heavyResponse = client.countUp({ limit: 6 });
        const quietResponse = client.countUp({ limit: 1 });
        expect(await heavyResponse.collect()).toHaveLength(6);
        expect(await quietResponse.collect()).toHaveLength(1);
        expect(responsePressure[0][5]).toBe(false);
        expect(responsePressure[1][0]).toBe(true);
        await waitFor(() => {
          const session = [...serverTransport.sessions.values()][0];
          expect(
            session.sendBuffer.filter((msg) => !isAck(msg.msg.controlFlags)),
          ).toHaveLength(0);
        });
        expect(violations).toEqual([]);
      } finally {
        await cleanupTransports([clientTransport, serverTransport]);
        await setup.cleanup();
        vi.useFakeTimers({ shouldAdvanceTime: true });
      }
    });
  },
);
