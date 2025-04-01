import { beforeEach, describe, test, expect, vi, assert } from 'vitest';
import { TestSetupHelpers, transports } from '../testUtil/fixtures/transports';
import { BinaryCodec, Codec } from '../codec';
import {
  advanceFakeTimersByHeartbeat,
  createPostTestCleanups,
} from '../testUtil/fixtures/cleanup';
import { createServer } from '../router/server';
import { createClient } from '../router/client';
import { TestServiceSchema } from '../testUtil/fixtures/services';
import { waitFor } from '../testUtil/fixtures/cleanup';
import { numberOfConnections, closeAllConnections } from '../testUtil';
import { cleanupTransports } from '../testUtil/fixtures/cleanup';
import { testFinishesCleanly } from '../testUtil/fixtures/cleanup';
import { ProtocolError } from '../transport/events';

let isOom = false;
// simulate RangeError: Array buffer allocation failed
const OomableCodec: Codec = {
  toBuffer(obj) {
    if (isOom) {
      throw new RangeError('failed allocation');
    }

    return BinaryCodec.toBuffer(obj);
  },
  fromBuffer: (buff: Uint8Array) => {
    return BinaryCodec.fromBuffer(buff);
  },
};

describe.each(transports)(
  'failed allocation test ($name transport)',
  async (transport) => {
    const clientOpts = { codec: OomableCodec };
    const serverOpts = { codec: BinaryCodec };

    const { addPostTestCleanup, postTestCleanup } = createPostTestCleanups();
    let getClientTransport: TestSetupHelpers['getClientTransport'];
    let getServerTransport: TestSetupHelpers['getServerTransport'];
    beforeEach(async () => {
      // only allow client to oom, server has sane oom handling already
      const setup = await transport.setup({
        client: clientOpts,
        server: serverOpts,
      });
      getClientTransport = setup.getClientTransport;
      getServerTransport = setup.getServerTransport;
      isOom = false;

      return async () => {
        await postTestCleanup();
        await setup.cleanup();
      };
    });

    test('oom during heartbeat kills the session, client starts new session', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );

      const errMock = vi.fn();
      clientTransport.addEventListener('protocolError', errMock);
      addPostTestCleanup(async () => {
        clientTransport.removeEventListener('protocolError', errMock);
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // establish initial connection
      const result = await client.test.add.rpc({ n: 1 });
      expect(result).toStrictEqual({ ok: true, payload: { result: 1 } });

      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));
      const oldClientSession = serverTransport.sessions.get('client');
      const oldServerSession = clientTransport.sessions.get('SERVER');
      assert(oldClientSession);
      assert(oldServerSession);

      // simulate some OOM during heartbeat
      for (let i = 0; i < 5; i++) {
        isOom = i % 2 === 0;
        await advanceFakeTimersByHeartbeat();
      }

      // verify session on client is dead
      await waitFor(() => expect(clientTransport.sessions.size).toBe(0));

      // verify we got MessageSendFailure errors
      await waitFor(() => {
        expect(errMock).toHaveBeenCalledWith(
          expect.objectContaining({
            type: ProtocolError.MessageSendFailure,
          }),
        );
      });

      // client should be able to reconnect and make new calls
      isOom = false;
      const result2 = await client.test.add.rpc({ n: 2 });
      expect(result2).toStrictEqual({ ok: true, payload: { result: 3 } });

      // verify new session IDs are different from old ones
      const newClientSession = serverTransport.sessions.get('client');
      const newServerSession = clientTransport.sessions.get('SERVER');
      assert(newClientSession);
      assert(newServerSession);
      expect(newClientSession.id).not.toBe(oldClientSession.id);
      expect(newServerSession.id).not.toBe(oldServerSession.id);

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });

    test('oom during handshake kills the session, client starts new session', async () => {
      // setup
      const clientTransport = getClientTransport('client');
      const serverTransport = getServerTransport();
      const services = { test: TestServiceSchema };
      const server = createServer(serverTransport, services);
      const client = createClient<typeof services>(
        clientTransport,
        serverTransport.clientId,
      );
      const errMock = vi.fn();
      clientTransport.addEventListener('protocolError', errMock);
      addPostTestCleanup(async () => {
        clientTransport.removeEventListener('protocolError', errMock);
        await cleanupTransports([clientTransport, serverTransport]);
      });

      // establish initial connection
      await client.test.add.rpc({ n: 1 });
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(1));
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(1));

      // close connection to force reconnection
      closeAllConnections(clientTransport);
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));

      // simulate OOM during handshake
      isOom = true;
      clientTransport.connect('SERVER');
      await waitFor(() => expect(numberOfConnections(serverTransport)).toBe(0));
      await waitFor(() => expect(numberOfConnections(clientTransport)).toBe(0));

      await waitFor(() => {
        expect(errMock).toHaveBeenCalledWith(
          expect.objectContaining({
            type: ProtocolError.MessageSendFailure,
          }),
        );
      });

      // client should be able to reconnect and make new calls
      isOom = false;
      const result = await client.test.add.rpc({ n: 2 });
      expect(result).toStrictEqual({ ok: true, payload: { result: 3 } });

      await testFinishesCleanly({
        clientTransports: [clientTransport],
        serverTransport,
        server,
      });
    });
  },
);
