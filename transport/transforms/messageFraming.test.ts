import { MessageFramer } from './messageFraming';
import { describe, test, expect, vi } from 'vitest';

describe('MessageFramer', () => {
  const encodeMessage = (message: string) => {
    return MessageFramer.write(Buffer.from(message));
  };

  test('basic transform', () => {
    const spy = vi.fn();
    const parser = MessageFramer.createFramedStream();

    parser.on('data', spy);
    parser.write(encodeMessage('content 1'));
    parser.write(encodeMessage('content 2'));
    parser.write(encodeMessage('content 3'));
    parser.write(encodeMessage('content 4'));
    parser.end();

    expect(spy).toHaveBeenNthCalledWith(1, Buffer.from('content 1'));
    expect(spy).toHaveBeenNthCalledWith(2, Buffer.from('content 2'));
    expect(spy).toHaveBeenNthCalledWith(3, Buffer.from('content 3'));
    expect(spy).toHaveBeenNthCalledWith(4, Buffer.from('content 4'));
    expect(spy).toHaveBeenCalledTimes(4);
  });

  test('handles partial messages across chunks', () => {
    const spy = vi.fn();
    const parser = MessageFramer.createFramedStream();

    const msg = encodeMessage('content 1');
    const part1 = msg.subarray(0, 5); // Split the encoded message
    const part2 = msg.subarray(5);

    parser.on('data', spy);
    parser.write(part1);
    parser.write(part2); // Complete the first message
    parser.write(encodeMessage('content 2')); // Second message
    parser.end();

    expect(spy).toHaveBeenNthCalledWith(1, Buffer.from('content 1'));
    expect(spy).toHaveBeenNthCalledWith(2, Buffer.from('content 2'));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('multiple messages in a single chunk', () => {
    const spy = vi.fn();
    const parser = MessageFramer.createFramedStream();

    const message1 = encodeMessage('first message');
    const message2 = encodeMessage('second message');
    const combinedMessages = Buffer.concat([message1, message2]);

    parser.on('data', spy);
    parser.write(combinedMessages); // Writing both messages in a single write operation
    parser.end();

    expect(spy).toHaveBeenNthCalledWith(1, Buffer.from('first message'));
    expect(spy).toHaveBeenNthCalledWith(2, Buffer.from('second message'));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test('max buffer size exceeded', () => {
    const parser = MessageFramer.createFramedStream({
      maxBufferSizeBytes: 8, // Set a small max buffer size
    });

    const spy = vi.fn();
    const err = vi.fn();
    parser.on('data', spy);
    parser.on('error', err);

    const msg = encodeMessage('long content');
    expect(msg.byteLength > 10);
    parser.write(msg);
    expect(spy).toHaveBeenCalledTimes(0);
    expect(err).toHaveBeenCalledTimes(1);
    parser.end();
  });

  test('incomplete message at stream end', () => {
    const spy = vi.fn();
    const err = vi.fn();
    const parser = MessageFramer.createFramedStream();

    parser.on('data', spy);
    parser.on('error', err);

    // say this is a 256B message
    const lengthPrefix = Buffer.alloc(4);
    lengthPrefix.writeUInt32BE(256, 0);

    // write a message that is clearly not 256B
    const incompleteMessage = Buffer.concat([
      lengthPrefix,
      Buffer.from('incomplete'),
    ]);
    parser.write(incompleteMessage);

    expect(spy).toHaveBeenCalledTimes(0);
    expect(err).toHaveBeenCalledTimes(0);

    parser.end();
    expect(spy).toHaveBeenCalledTimes(0);
    expect(err).toHaveBeenCalledTimes(0);
  });

  test('consistent byte length calculation with emojis and unicode', () => {
    const parser = MessageFramer.createFramedStream();
    const spy = vi.fn();
    parser.on('data', spy);

    const emojiMessage = '🇧🇪🇨🇦👨‍👩‍👧‍👦';
    const unicodeMessage = '你好，世界'; // "Hello, World" in Chinese

    parser.write(encodeMessage(emojiMessage));
    parser.write(encodeMessage(unicodeMessage));
    parser.end();

    expect(spy).toHaveBeenNthCalledWith(1, Buffer.from(emojiMessage));
    expect(spy).toHaveBeenNthCalledWith(2, Buffer.from(unicodeMessage));
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
