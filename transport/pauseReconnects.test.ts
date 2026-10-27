import { describe, test, expect, beforeEach } from 'vitest';
import { Type } from 'typebox';
import {
  closeAllConnections,
  createDummyTransportMessage,
  getClientSendFn,
  numberOfConnections,
  waitForMessage,
} from '../testUtil';
import {
  advanceFakeTimersByConnectionBackoff,
  advanceFakeTimersBySessionGrace,
  cleanupTransports,
  createPostTestCleanups,
  testFinishesCleanly,
  waitFor,
} from '../testUtil/fixtures/cleanup';
import { testMatrix } from '../testUtil/fixtures/matrix';
import { TestSetupHelpers } from '../testUtil/fixtures/transports';
import { EventMap } from './events';
import { SessionState } from './sessionStateMachine';

describe.each(testMatrix(['all', 'naive']))(
  'pausing client reconnects ($transport.name transport)',
  ({ transport }) => {
    let testHelpers: TestSetupHelpers;
    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    beforeEach(async () => {
      testHelpers = await transport.setup();

      return async () => {
        await postTestCleanup();
        await testHelpers.cleanup();
      };
    });

    function getTransports() {
      const clientTransport = testHelpers.getClientTransport('client');
      const serverTransport = testHelpers.getServerTransport();
      addPostTestCleanup(async () => {
        await cleanupTransports([clientTransport, serverTransport]);
      });

      return { clientTransport, serverTransport };
    }

    test('pausing while backing off cancels the dial and keeps the session', async () => {
      const { clientTransport, serverTransport } = getTransports();
      clientTransport.connect(serverTransport.clientId);
      const session = clientTransport.sessions.get(serverTransport.clientId);
      expect(session?.state).toBe(SessionState.BackingOff);

      clientTransport.pauseReconnects();
      await advanceFakeTimersByConnectionBackoff();

      const pausedSession = clientTransport.sessions.get(
        serverTransport.clientId,
      );
      expect(pausedSession?.state).toBe(SessionState.NoConnection);
      expect(pausedSession?.id).toBe(session?.id);
      expect(serverTransport.pendingSessions.size).toBe(0);
      expect(serverTransport.sessions.size).toBe(0);
    });

    test('pausing while connecting closes the connection once it opens', async () => {
      const { clientTransport, serverTransport } = getTransports();
      const pauseOnConnecting = (evt: EventMap['sessionTransition']) => {
        if (evt.state === SessionState.Connecting) {
          clientTransport.pauseReconnects();
        }
      };
      clientTransport.addEventListener('sessionTransition', pauseOnConnecting);
      clientTransport.connect(serverTransport.clientId);
      const sessionId = clientTransport.sessions.get(serverTransport.clientId)
        ?.id;

      await advanceFakeTimersByConnectionBackoff();

      const session = clientTransport.sessions.get(serverTransport.clientId);
      expect(session?.state).toBe(SessionState.NoConnection);
      expect(session?.id).toBe(sessionId);
      await waitFor(() => {
        expect(serverTransport.pendingSessions.size).toBe(0);
      });
      expect(serverTransport.sessions.size).toBe(0);
    });

    test('pausing while handshaking closes the connection', async () => {
      const schema = Type.Object({});
      let finishValidation: (() => void) | undefined;
      const clientTransport = testHelpers.getClientTransport('client', {
        schema,
        construct: () => ({}),
      });
      const serverTransport = testHelpers.getServerTransport('SERVER', {
        schema,
        validate: () =>
          new Promise<object>((resolve) => {
            finishValidation = () => resolve({});
          }),
      });
      addPostTestCleanup(async () => {
        finishValidation?.();
        await cleanupTransports([clientTransport, serverTransport]);
      });

      clientTransport.connect(serverTransport.clientId);
      await waitFor(() => expect(finishValidation).toBeDefined());
      const session = clientTransport.sessions.get(serverTransport.clientId);
      expect(session?.state).toBe(SessionState.Handshaking);

      clientTransport.pauseReconnects();

      const pausedSession = clientTransport.sessions.get(
        serverTransport.clientId,
      );
      expect(pausedSession?.state).toBe(SessionState.NoConnection);
      expect(pausedSession?.id).toBe(session?.id);
      await waitFor(() => {
        expect(serverTransport.pendingSessions.size).toBe(0);
      });
    });

    test('pausing leaves a connected session open', async () => {
      const { clientTransport, serverTransport } = getTransports();
      clientTransport.connect(serverTransport.clientId);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));

      clientTransport.pauseReconnects();
      expect(numberOfConnections(clientTransport)).toBe(1);

      const msg = createDummyTransportMessage();
      const msgId = getClientSendFn(clientTransport, serverTransport)(msg);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msgId),
      ).resolves.toStrictEqual(msg.payload);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('a connection dropped while paused waits for resume, which redials the same session at once', async () => {
      const { clientTransport, serverTransport } = getTransports();
      clientTransport.connect(serverTransport.clientId);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      const sessionId = clientTransport.sessions.get(serverTransport.clientId)
        ?.id;

      clientTransport.pauseReconnects();
      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));
      await advanceFakeTimersByConnectionBackoff();
      expect(
        clientTransport.sessions.get(serverTransport.clientId)?.state,
      ).toBe(SessionState.NoConnection);

      const msg = createDummyTransportMessage();
      const msgId = getClientSendFn(clientTransport, serverTransport)(msg);
      clientTransport.resumeReconnects();

      expect(
        clientTransport.sessions.get(serverTransport.clientId)?.state,
      ).toBe(SessionState.Connecting);
      await expect(
        waitForMessage(serverTransport, (recv) => recv.id === msgId),
      ).resolves.toStrictEqual(msg.payload);
      expect(clientTransport.sessions.get(serverTransport.clientId)?.id).toBe(
        sessionId,
      );
      expect(serverTransport.sessions.get(clientTransport.clientId)?.id).toBe(
        sessionId,
      );

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
      });
    });

    test('a paused session is still closed when its grace period elapses', async () => {
      const { clientTransport, serverTransport } = getTransports();
      const closedSessionIds: Array<string> = [];
      clientTransport.addEventListener('sessionStatus', (evt) => {
        if (evt.status === 'closed') {
          closedSessionIds.push(evt.session.id);
        }
      });
      clientTransport.connect(serverTransport.clientId);
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      const sessionId = clientTransport.sessions.get(serverTransport.clientId)
        ?.id;

      clientTransport.pauseReconnects();
      closeAllConnections(clientTransport);
      await advanceFakeTimersBySessionGrace();

      await waitFor(() => expect(closedSessionIds).toStrictEqual([sessionId]));
      expect(clientTransport.sessions.size).toBe(0);
    });
  },
);
