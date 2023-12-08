import { expect } from 'vitest';
import { Connection, Transport } from '../../transport';
import { Server } from '../../router';

export function ensureTransportIsClean(t: Transport<Connection>) {
  expect(t.state, 'transport should be closed after the test').to.not.equal(
    'open',
  );
  expect(
    t.connections,
    'transport should not have open connections after the test',
  ).toStrictEqual(new Map());
  expect(
    t.messageHandlers,
    'transport should not have open message handlers after the test',
  ).toStrictEqual(new Set());
  expect(
    t.sendQueue,
    'transport should not have any messages its waiting to send after the test',
  ).toStrictEqual(new Map());
  return true;
}

export function ensureServerIsClean(s: Server<unknown>) {
  expect(
    s.streams,
    'server should not have any open streams after the test',
  ).toStrictEqual(new Map());
  return true;
}
