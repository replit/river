import { describe, expect, test, vitest } from 'vitest';
import { EventDispatcher } from './events';
import { OpaqueTransportMessage } from '.';
import { nanoid } from 'nanoid';

function dummyMessage(): OpaqueTransportMessage {
  return {
    id: nanoid(),
    from: nanoid(),
    to: nanoid(),
    seq: 0,
    ack: 0,
    streamId: nanoid(),
    controlFlags: 0,
    payload: nanoid(),
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
});
