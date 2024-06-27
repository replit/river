import { describe, expect, test, vitest } from 'vitest';
import { EventDispatcher } from './events';
import { OpaqueTransportMessage } from '.';
import { generateId } from './id';

function dummyMessage(): OpaqueTransportMessage {
  return {
    id: generateId(),
    from: generateId(),
    to: generateId(),
    seq: 0,
    ack: 0,
    streamId: generateId(),
    controlFlags: 0,
    payload: generateId(),
  };
}

describe('EventDispatcher', () => {
  test('notifies all handlers in order they were registered', () => {
    const dispatcher = new EventDispatcher();

    const handler1 = vitest.fn();
    const handler2 = vitest.fn();
    const sessionStatusHandler = vitest.fn();

    dispatcher.addEventListener('message', handler1);
    dispatcher.addEventListener('message', handler2);
    dispatcher.addEventListener('sessionStatus', sessionStatusHandler);

    expect(dispatcher.numberOfListeners('message')).toEqual(2);

    const message = dummyMessage();

    dispatcher.dispatchEvent('message', message);

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
    expect(handler1).toHaveBeenCalledWith(message);
    expect(handler2).toHaveBeenCalledWith(message);
    expect(handler1.mock.invocationCallOrder[0]).toBeLessThan(
      handler2.mock.invocationCallOrder[0],
    );
    expect(sessionStatusHandler).toHaveBeenCalledTimes(0);
  });

  test('does not notify removed handlers', () => {
    const dispatcher = new EventDispatcher();

    const handler1 = vitest.fn();
    const handler2 = vitest.fn();

    dispatcher.addEventListener('message', handler1);
    dispatcher.addEventListener('message', handler2);

    dispatcher.removeEventListener('message', handler1);
    dispatcher.removeEventListener('message', function neverRegistered() {
      /** */
    });

    expect(dispatcher.numberOfListeners('message')).toEqual(1);

    const message = dummyMessage();

    dispatcher.dispatchEvent('message', message);

    expect(handler1).toHaveBeenCalledTimes(0);
    expect(handler2).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledWith(message);
  });

  test('does not notify handlers added while notifying another handler', () => {
    const dispatcher = new EventDispatcher();

    const handler1 = vitest.fn(() => {
      dispatcher.addEventListener('message', handler2);
    });
    const handler2 = vitest.fn();

    dispatcher.addEventListener('message', handler1);

    const message = dummyMessage();

    dispatcher.dispatchEvent('message', message);

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(0);

    dispatcher.dispatchEvent('message', message);

    expect(handler1).toHaveBeenCalledTimes(2);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  test('does notify handlers removed while notifying another handler', () => {
    const dispatcher = new EventDispatcher();

    const handler1 = vitest.fn();
    const handler2 = vitest.fn(() => {
      dispatcher.removeEventListener('message', handler1);
    });

    dispatcher.addEventListener('message', handler1);
    dispatcher.addEventListener('message', handler2);

    const message = dummyMessage();

    dispatcher.dispatchEvent('message', message);

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);

    dispatcher.dispatchEvent('message', message);

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(2);
  });

  test('removes all listeners', () => {
    const dispatcher = new EventDispatcher();

    const handler = vitest.fn();
    dispatcher.addEventListener('message', handler);
    dispatcher.addEventListener('connectionStatus', handler);
    dispatcher.addEventListener('protocolError', handler);
    dispatcher.addEventListener('sessionStatus', handler);
    dispatcher.addEventListener('transportStatus', handler);

    dispatcher.removeAllListeners();
    expect(dispatcher.numberOfListeners('message')).toEqual(0);
    expect(dispatcher.numberOfListeners('connectionStatus')).toEqual(0);
    expect(dispatcher.numberOfListeners('protocolError')).toEqual(0);
    expect(dispatcher.numberOfListeners('sessionStatus')).toEqual(0);
    expect(dispatcher.numberOfListeners('transportStatus')).toEqual(0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    dispatcher.dispatchEvent('message', {} as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    dispatcher.dispatchEvent('connectionStatus', {} as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    dispatcher.dispatchEvent('protocolError', {} as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    dispatcher.dispatchEvent('sessionStatus', {} as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
    dispatcher.dispatchEvent('transportStatus', {} as any);

    expect(handler).toHaveBeenCalledTimes(0);
  });
});
