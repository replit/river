import { expect, vi } from 'vitest';
import { Connection, Transport } from '../../transport';
import { Server } from '../../router';

export async function ensureTransportIsClean(t: Transport<Connection>) {
  expect(
    t.state,
    `transport ${t.clientId} should be closed after the test`,
  ).to.not.equal('open');
  expect(
    t.connections,
    `transport ${t.clientId} should not have open connections after the test`,
  ).toStrictEqual(new Map());
  expect(
    t.messageHandlers,
    `transport ${t.clientId} should not have open message handlers after the test`,
  ).toStrictEqual(new Set());

  vi.waitUntil(() => t.sendQueue.size === 0).finally(() => {
    expect(
      t.sendQueue,
      `transport ${t.clientId} should not have any messages waiting to send after the test`,
    ).toStrictEqual(new Map());
  });
}

export async function ensureServerIsClean(s: Server<unknown>) {
  return vi.waitUntil(() => s.streams.size === 0);
}

export async function testFinishesCleanly({
  clientTransports,
  serverTransport,
  server,
}: Partial<{
  clientTransports: Array<Transport<Connection>>;
  serverTransport: Transport<Connection>;
  server: Server<unknown>;
}>) {
  if (clientTransports) {
    await Promise.all(clientTransports.map((t) => t.close()));
    await Promise.all(clientTransports.map(ensureTransportIsClean));
  }

  // server sits on top of server transport so we clean it up first
  if (server) {
    await ensureServerIsClean(server);
    await server.close();
  }

  if (serverTransport) {
    await serverTransport.close();
    await ensureTransportIsClean(serverTransport);
  }
}
