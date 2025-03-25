import { beforeEach, describe, expect, test, vi } from 'vitest';
import { testMatrix } from '../testUtil/fixtures/matrix';
import { TestSetupHelpers } from '../testUtil/fixtures/transports';
import { createPostTestCleanups } from '../testUtil/fixtures/cleanup';
import { TestServiceSchema } from '../testUtil/fixtures/services';
import { createServer } from '../router/server';
import { createClient } from '../router/client';
import { closeAllConnections } from '../testUtil';
import { cleanupTransports } from '../testUtil/fixtures/cleanup';
import { SessionState } from '../transport';
import { SessionId } from '../transport/sessionStateMachine/common';

type ActionWeights = {
  newStream: number;
  sendMessage: number;
  closeStream: number;
  closeConnection: number;
  openConnection: number;
};

type ActionConfig = {
  name: string;
  weights: ActionWeights;
};

const actionConfigs: Array<ActionConfig> = [
  // {
  //   name: 'message heavy',
  //   weights: {
  //     newStream: 1,
  //     sendMessage: 10,
  //     closeStream: 1,
  //     closeConnection: 0,
  //     openConnection: 0,
  //   }
  // },
  // {
  //   name: 'stream churn',
  //   weights: {
  //     newStream: 1,
  //     sendMessage: 1,
  //     closeStream: 1,
  //     closeConnection: 0,
  //     openConnection: 0,
  //   }
  // },
  {
    name: 'connection churn',
    weights: {
      newStream: 1,
      sendMessage: 500,
      closeStream: 1,
      closeConnection: 1,
      openConnection: 1,
    },
  },
];

describe.each(testMatrix(['ws', 'binary']))(
  'fuzz test ($transport.name transport, $codec.name codec)',
  async ({ transport, codec }) => {
    const opts = { codec: codec.codec };

    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    let getClientTransport: TestSetupHelpers['getClientTransport'];
    let getServerTransport: TestSetupHelpers['getServerTransport'];
    beforeEach(async () => {
      const setup = await transport.setup({ client: opts, server: opts });
      getClientTransport = setup.getClientTransport;
      getServerTransport = setup.getServerTransport;

      return async () => {
        await postTestCleanup();
        await setup.cleanup();
      };
    });

    describe.each(actionConfigs)('$name action distribution', ({ weights }) => {
      test('fuzz test', { timeout: 0 }, async () => {
        vi.useRealTimers();

        const clientInvariantViolation = vi.fn();
        const serverInvariantViolation = vi.fn();

        const clientSessionTransitions = new Map<
          SessionId,
          Array<SessionState>
        >();
        const serverSessionTransitions = new Map<
          SessionId,
          Array<SessionState>
        >();

        const clientTransport = getClientTransport('client');
        const serverTransport = getServerTransport();

        clientTransport.addEventListener(
          'protocolError',
          clientInvariantViolation,
        );
        serverTransport.addEventListener(
          'protocolError',
          serverInvariantViolation,
        );

        clientTransport.addEventListener('sessionTransition', (evt) => {
          clientSessionTransitions.set(evt.id, [
            ...(clientSessionTransitions.get(evt.id) || []),
            evt.state,
          ]);
        });
        serverTransport.addEventListener('sessionTransition', (evt) => {
          serverSessionTransitions.set(evt.id, [
            ...(serverSessionTransitions.get(evt.id) || []),
            evt.state,
          ]);
        });

        const services = { test: TestServiceSchema };
        createServer(serverTransport, services);
        const client = createClient<typeof services>(
          clientTransport,
          serverTransport.clientId,
        );
        addPostTestCleanup(async () => {
          await cleanupTransports([clientTransport, serverTransport]);
        });

        const startTime = Date.now();
        const endTime = startTime + 60000;

        const streams = [client.test.echo.stream({})];
        const actionLog: Array<{
          timestamp: number;
          action: keyof ActionWeights;
        }> = [];

        let isConnected = true;

        while (Date.now() < endTime) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.random() * 10),
          );

          // Sample an action based on weights
          const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
          let random = Math.random() * totalWeight;
          let runningSum = 0;
          let selectedAction: keyof ActionWeights;

          // More robust action selection
          for (const [action, weight] of Object.entries(weights)) {
            runningSum += weight;
            if (random < runningSum) {
              selectedAction = action as keyof ActionWeights;
              break;
            }
          }

          // Execute the selected action
          switch (selectedAction!) {
            case 'newStream':
              streams.push(client.test.echo.stream({}));
              actionLog.push({
                timestamp: Date.now(),
                action: 'newStream',
              });
              break;

            case 'sendMessage':
              if (streams.length > 0) {
                const streamIndex = Math.floor(Math.random() * streams.length);
                const stream = streams[streamIndex];
                if (stream.reqWritable.isWritable()) {
                  stream.reqWritable.write({
                    msg: Math.random().toString(),
                    ignore: false,
                  });
                  actionLog.push({
                    timestamp: Date.now(),
                    action: 'sendMessage',
                  });
                }
              }
              break;

            case 'closeStream':
              if (streams.length > 0) {
                const streamIndex = Math.floor(Math.random() * streams.length);
                const stream = streams[streamIndex];
                stream.reqWritable.close();
                streams.splice(streamIndex, 1);
                actionLog.push({
                  timestamp: Date.now(),
                  action: 'closeStream',
                });
              }
              break;

            case 'closeConnection':
              if (isConnected) {
                clientTransport.reconnectOnConnectionDrop = false;
                closeAllConnections(clientTransport);
                isConnected = false;
                actionLog.push({
                  timestamp: Date.now(),
                  action: 'closeConnection',
                });
              }
              break;

            case 'openConnection':
              if (!isConnected) {
                clientTransport.reconnectOnConnectionDrop = true;
                clientTransport.connect(serverTransport.clientId);
                isConnected = true;
                actionLog.push({
                  timestamp: Date.now(),
                  action: 'openConnection',
                });
              }
              break;
          }
        }

        // Print summary report
        const totalActions = actionLog.length;
        const actionCounts = actionLog.reduce(
          (counts, log) => {
            counts[log.action] = (counts[log.action] || 0) + 1;
            return counts;
          },
          {} as Record<keyof ActionWeights, number>,
        );

        console.log('\nFuzz Test Summary:');
        console.log('=================');
        console.log(`Total test duration: ${(endTime - startTime) / 1000}s`);
        console.log(`Total actions performed: ${totalActions}`);
        console.log('\nAction distribution:');
        Object.entries(actionCounts).forEach(([action, count]) => {
          const percentage = ((count / totalActions) * 100).toFixed(1);
          console.log(`- ${action}: ${count} (${percentage}%)`);
        });
        console.log(
          `Actions/second: ${(
            totalActions /
            ((endTime - startTime) / 1000)
          ).toFixed(1)}`,
        );

        // Print session transition timelines
        console.log('\nSession Transition Timelines:');
        console.log('===========================');

        console.log('\nClient Sessions:');
        for (const [
          sessionId,
          transitions,
        ] of clientSessionTransitions.entries()) {
          console.log(`\nSession ${sessionId}:`);
          transitions.forEach((state, index) => {
            console.log(`${index + 1}. ${state}`);
          });
        }

        console.log('\nServer Sessions:');
        for (const [
          sessionId,
          transitions,
        ] of serverSessionTransitions.entries()) {
          console.log(`\nSession ${sessionId}:`);
          transitions.forEach((state, index) => {
            console.log(`${index + 1}. ${state}`);
          });
        }
        console.log('===========================\n');

        expect(clientInvariantViolation).not.toHaveBeenCalled();
        expect(serverInvariantViolation).not.toHaveBeenCalled();
      });
    });
  },
);
