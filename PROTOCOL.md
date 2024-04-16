# River protocol `v1`

## Abstract

River is an [application-level protocol](https://www.cloudflare.com/learning/ddos/what-is-layer-7/) designed to facilitate long-lived streaming Remote Procedure Calls (RPCs) over various transport mechanisms.
The protocol itself is transport agnostic, allowing it to operate over any ordered byte-stream transport, such as WebSockets, or Unix Domain Sockets.
It supports full-duplex communication, service multiplexing, and transparent handling of connection disruptions.

The primary goal of the River protocol is to simplify the development of long-lived client-server systems by abstracting the complexities of network programming, like connection management, message serialization/deserialization, and error handling.

The River protocol enables communication between clients and servers via remote procedure calls (RPCs). This document outlines the protocol's specifications, including client-server communication, message serialization, handling of connection disruptions, and stream management.

```
┌────────────┐                                            ┌────────────┐
│ rpc(data)  │ - - - - - - - - - - - - - - - - - - - - ─► │ handler(..)│
├────────────┤                                            ├────────────┤
│ Stream     │                                            │ Stream     │
└────────────┘                                            └────────────┘
      ▼ n:1                                                     ▼ n:1
┌────────────┐                                            ┌────────────┐
│ Client     │                                            │     Server │
├────────────┤        emitted events                      ├────────────┤
│ Transport  │ ─────► (message, connectionStatus, etc.)   │  Transport │
└────────────┘                                            └────────────┘
      ▼ 1:n    (transport can have multiple sessions)           ▼ 1:n
┌────────────┐                                            ┌────────────┐
│ Session    │                                            │    Session │
└────────────┘                                            └────────────┘
      ▼ 1:0..1 (session can have 0-1 connections)               ▼ 1:0..1
┌────────────┐                                            ┌────────────┐
│ Connection │                                            │ Connection │
├────────────┤                                            ├────────────┤
│ Codec      │                                            │      Codec │
└────────────┘                                            └────────────┘
      ▲                            wire                          ▲
      └──────────────────────────────────────────────────────────┘
```

The design of the protocol emphasizes three things in descending priority:

1. clearly separable layers of abstraction;
1. resilience in the face of various network conditions;
1. raw performance.

The protocol specification defines semantics around:

- How clients connect to servers.
- How they negotiate a connection an start a session.
- How messages in a session are serialized and deserialized.
  - Dealing with message retransmission and deduplication.

Note that this protocol specification does NOT detail the language-level specifics of how the client returns results to the caller and how the server executes the procedure invocations but rather the wire-level protocol that the client and server must adhere to.

## Clients, servers, and RPCs

- A 'client' can initiate remote procedure calls to the server
- A 'server' can execute remote procedure calls and return the result to the requesting client

'Remote procedure calls' (RPC) in River take one of four types:

1. `rpc`: the client sends 1 message, the server responds with 1 message.
1. `stream`: the client sends n messages, the server responds with m messages.
1. `upload`: the client sends n messages, the server responds with 1 message.
1. `subscription`: the client sends 1 message, the server responds with m messages.

A server (also called a router) is made up of multiple 'services'. Each 'service' has multiple 'procedures'.
A procedure declares its type (`rpc | stream | upload | subscription`), an input message type (`Input`), an output message type (`Output`), an error type (`Error`), and the associated handler.

The type signatures (in TypeScript) for the handlers of each of the procedure types are as follows:

- `rpc`: `Input -> Result<Output, Error>`
- `upload`: `AsyncIter<Input> -> Result<Output, Error>`
  - with init message: `Init, AsyncIter<Input> -> Result<Output, Error>`
- `subscription`: `Input -> Pushable<Result<Output, Error>>`
- `stream`: `AsyncIter<Input> -> Pushable<Result<Output, Error>>`
  - with init message: `Init, AsyncIter<Input> -> Pushable<Result<Output, Error>>`

Note that any procedure that has a client-to-server procedure stream (i.e. `stream` and `upload`) can optionally define a single initialization message to be sent to the server before the client starts sending the actual `Input` messages.

The types of `Input`, `Init`, `Output`, and `Error` MUST be representable as JSON schema.
In the official TypeScript implementation, this is done via [TypeBox](https://github.com/sinclairzx81/typebox).
The server is responsible for doing run-time type validation on incoming messages to ensure they match the handler's type signature before passing it to the handler.

However, the messages from the client to the server must also contain additional information so that the server knows where to route the message payload.
This wrapper message is referred to as a 'transport message'.

The schema for the transport message is as follows:

```ts
interface TransportMessage<Payload> {
  // unique id
  id: string;

  // each client/server has its own unique id
  // who we are
  from: string;
  // who we are sending to
  to: string;

  // the service and procedure to route to
  serviceName?: string;
  procedureName?: string;

  // the actual payload
  // - `Input` in the client to server direction
  // - `Result<Output, Error>` in the server to client direction
  payload: Payload;

  // unique id for each specific instantiation of an RPC call
  // a stream of TransportMessage is grouped by streamId
  streamId: string;

  // special flags
  // we will cover this later
  controlFlags: number;

  // used primarily for retransmission and deduplication
  // we will cover this later
  seq: number;
  ack: number;
}

type Result<T, E> = { ok: true; payload: T } | { ok: false; payload: E };
```

A single 'invocation' of a handler is assigned a unique `streamId`, which is used to label all inbound and outbound messages associated with that invocation (this grouping is referred to as a 'procedure stream' or 'stream').

The `controlFlags` property is a [bit field](https://en.wikipedia.org/wiki/Bit_field) used to signal special conditions, such as the start of a stream, the end of the stream, and an explicit acknowledgement message.

- The `AckBit` (`0b00001`) MUST only be set in the case of an explicit heartbeat that _only_ contains ack/seq information and no application-level payload (i.e., only used to update transport level bookkeeping).
- The `StreamOpenBit` (`0b00010`) MUST be set for the first message of a new stream.
- The `StreamClosedBit` (`0b00100`) MUST be set for the last message of a stream.
- Bits `0b01000` and `0b10000` are reserved for future use and are currently unused.
  - `0b01000` will likely be used to signal `StreamAbort` (i.e., the client is aborting the stream)

All messages MUST have no control flags set (i.e., the `controlFlags` field is `0b00000`) unless:

- It is the first message of a new stream, in which case the `StreamOpenBit` MUST be set.
  - The first message of a stream MUST be initiated from the client.
  - The client MUST also generate a unique `streamId` for the message, which will be constant throughout the lifetime of the stream.
  - The client must set `serviceName` and `procedureName` as the correct string for the associated service and procedure.
    - All further messages MAY omit `serviceName` and `procedureName` as they are implied by the first message and are constant throughout the lifetime of a stream.
- It is the last message of a stream, in which case the `StreamClosedBit` MUST be set.
  - If this is a control message sent due to manual closure or the handler itself ending the stream, the payload MUST be `{ type: 'CLOSE' }`. This case will be detailed further down in the 'Ending Streams' subheader of the 'Stream Lifecycle' heading.
- It is an explicit heartbeat, so the `AckBit` MUST be the only bit set.
  - The payload MUST be `{ type: 'ACK' }`.
  - Because this is a control message that is not associated with a specific stream, you MUST NOT set `serviceName` or `procedureName` and `streamId` can be something arbitrary (e.g. `heartbeat`).

## Streams

Streams tie together a series of messages into a single logical 'stream' of communication associated with a single remote procedure invocation.
For example, in the case of a `stream` RPC, the client will send a series of messages with the same `streamId`, and the server must respond with a series of messages with the same `streamId`.

### Starting streams

Streams MUST only be started by the client through the invocation of a procedure.
Once a procedure is invoked, it opens a new stream and sends the first message of the stream (in accordance with the 'Sending Messages' heading below) and listen to messages on that same `streamId`.

### Handling messages for streams

#### Both client and server

When a message is received, it MUST be validated before being processed.

- Match the JSON schema for the `TransportMessage` type.
- Have an existing session for the transport `clientId` in the `from` field (see the 'Transports, Sessions, and Connections' heading for more information on sessions and transports).
- The `to` field of the message MUST match the transport's `clientId`.
- Have the expected `seq` number (see the 'Handling Transparent Reconnections' heading for more information on seq/ack).
- Is not an explicit heartbeat (i.e. the `AckBit` is not set).

When a message is validated at this level, the implementor must update the bookkeeping information for the session (see the 'Transparent Reconnections' heading for more information).

Then, depending on whether this is a client or server, the message must undergo further validation before being handled.

#### On the client

For an incoming message to be considered valid on the client, the transport message MUST fulfill the following criteria:

- It should have a `streamId` that the client recognizes. That is, there MUST already be a message listener waiting for messages on the `streamId` of the original request message (recall that streams are only initiated by clients).

If the message is invalid, the client MUST silently discard the message.
Otherwise, this is a normal message. Unwrap the payload and return it to the caller of the original procedure.

In the special case that the incoming message is an explicit stream close control message, the client MUST end the user-facing output stream and cleanup the stream (see the section below on 'Lifetime of Streams' for more information on when these explicit close messages are sent). The message MUST NOT be passed to the user-facing output stream.

#### On the server

For an incoming message to be considered valid on the server, the transport message MUST fulfill the following criteria:

- It should match the JSON schema for the `TransportMessage` type.
- If the message has the `StreamOpenBit` set, it MUST have a `serviceName` and `procedureName`. The server MUST open a new stream and start a new instantiation of the handler for the specific `serviceName` and `procedureName`. The server should maintain a mapping of `streamId` to the handler instantiation so that future messages with the same `streamId` can be routed to the correct instantiation of the handler.
- If the message does not have the `StreamOpenBit` set, it MUST have a `streamId` that the server recognizes and has an associated handler open for.
- If this is the first message of the stream AND the associated procedure declares an `Init` message, the internal payload of the message should match the JSON schema for the `Init` type of the associated handler, and the server should pass the `Init` message to the handler.
- If this is not the first message of the stream, the internal payload of the message should match the JSON schema for the `Input` type of the associated handler, and the server should pass the `Input` message to the handler.

If the message is invalid, the server MUST silently discard the message without delivering it to the handler.
Otherwise, the message is a normal message. Unwrap the payload and pass it to the handler associated with the `streamId` of the message.

In the special case that the message payload matches the `ControlMessagePayloadSchema` and has the `StreamClosedBit` set, the server should close the input stream for the handler. The message MUST NOT be passed to the handler.

#### Lifetime of streams

The following section will provide diagrams detailing the lifetime of streams for each of the four types of RPCs.

The legend is as follows:

- `>` represents a message with the `StreamOpenBit` set.
- `<` represents a message with the `StreamClosedBit` set.
  - `{` represents a message with the `StreamClosedBit` set and the payload `{ type: 'CLOSE' }`.
- `x` represents a message with both the `StreamOpenBit` and `StreamClosedBit` set.
- `-` represents a message with no control flags set.

As the `ACK` control message is unrelated to the stream lifecycle, it will not be included in the diagrams.

##### RPC

An `rpc` procedure starts with the client sending a single message with `StreamOpenBit` set and `StreamClosedBit` set and waits for a response message with the `StreamClosedBit` set.

```
client: x
server:  <
```

##### Stream

A `stream` procedure starts with the client sending a single message with the `StreamOpenBit` set. It remains open until the client manually ends the stream by sending a final control message with the `StreamClosedBit` set.

After receiving, the server MUST send a final control message with the `StreamClosedBit` set when the input stream is exhausted.

```
client: > --  - {
server:  -  -- - {
```

Note that not every message from the client will result in a message from the server. The server may choose to send messages at any time.

##### Upload

An `upload` procedure starts with the client sending a single message with `StreamOpenBit` set and remains open until the client manually closes the input stream by sending a final control message with the `StreamClosedBit` set.
The server MUST send a final control message with the `StreamClosedBit` set when the input stream is exhausted.

```
client: > --  - {
server:          <
```

##### Subscription

A `subscription` procedure starts with the client sending a single message with the `StreamOpenBit` set and remains open until the client manually ends the stream by sending a final control message with the `StreamClosedBit` set.

```
client: >       {
server:  -  -- - {
```

## Wire format

The wire format is configurable and is not specified by the protocol itself.

The TypeScript implementation utilizes a `Codec` class to handle the encoding and decoding of `TransportMessage`s to and from the wire in the form of raw bytes.

The TypeScript implementation has two main codecs:

1. `NaiveCodec`: a simple codec that uses JSON.stringify and JSON.parse to encode and decode messages directly to utf-8 bytes.
2. `BinaryCodec`: a more efficient codec that uses the [`msgpack`](https://msgpack.org/) format to encode and decode messages to and from raw bytes.

Depending on whether the underlying transport does message framing, the codec may need to handle message framing and deframing as well.
For example, the WebSocket protocol has built-in message framing, so the codec only needs to handle encoding and decoding messages to and from raw bytes.
On the other hand, the UDS protocol does not have built-in message framing, so the codec must handle message framing and deframing as well.
The TypeScript implementation uses `uint32`-big-endian-length-prefixed message framing.

## Transports, sessions, and connections

A `Transport` is responsible for managing the lifecycle (creation/deletion) of sessions and connections.
In the TypeScript implementation, the `Transport` class is further subclassed into `ServerTransport` and `ClientTransport` to handle some of the specific behavior of the server and client, respectively.

A `Session` is a higher-level abstraction that operates over the span of potentially multiple transport-level connections.
It's responsible for tracking any metadata for a particular client that might need to be persisted across connections (i.e., the `sendBuffer`, `ack`, `seq`)

A `Connection` is the actual raw underlying transport connection.
It is responsible for dispatching to/from the actual connection itself.
It's lifecycle is tied to the lifecycle of the underlying transport connection (i.e. if the WebSocket drops, this connection should be deleted).

The protocol also defines the concept of an `instanceId`, which is a unique identifier for a specific instantiation of a client or server.

### Why distinguish between `Transport` and `Session`?

The distinction between `Transport` and `Session` is important because it allows us to have transparent reconnections.

This means even if the actual wire connection drops, the client and server can buffer messages on both sides until the connection is re-established.
At the application level, it appears as if the connection never dropped.

### Creating connections and sessions

A `Connection` object MUST be created immediately upon establishing a raw wire connection.
Subsequently, a `Session` object is created for each `Connection` object once the protocol handshake over the `Connection` is completed.
The process differs slightly between the client and server:

#### Client

- The protocol handshake is initiated and sent as soon as the `Connection` is created, followed by attaching a message listener to the `Connection`.
  - Initially, only protocol handshake responses are listened for. (Further details on the protocol handshake can be found under the 'Handshake' heading below).
  - If the handshake fails, the `Connection` is closed immediately.
  - Otherwise, consider the handshake successful and proceed to the next step.
  - The client should check for an existing `Session` for the `clientId` associated with the `Connection`.
    - If an existing `Session` is found, it is verified whether the last `instanceId` associated with the previous `Session` matches the `instanceId` in the handshake response.
      - A match in `instanceId` means a reconnection to the same session, and that the server still has the state for this session.
        - The stale `Connection` object associated with the `Session` is closed, and replaced with the new `Connection` object.
        - Any buffered messages are resent.
      - If they do not match, it indicates the server has lost the session state. The old session is removed, its `Connection` object and heartbeat are closed, and processing falls through to the case of not having an associated session.
    - If no associated session exists, a new `Session` object is created for the `Connection` and associated with each other.
  - After a successful handshake, the protocol handshake listener is removed and replaced with the regular message listener.
- A close event listener is attached to the `Connection` to handle unexpected closures. This event listener should:
  - Close the underlying wire connection if still open.
  - Initiate the grace period for the associated `Session`'s destruction.
  - Attempt to reconnect to the server.

#### Server

- A message listener is attached to the `Connection` as soon as it is created.
  - Initially, only protocol handshake requests are listened for.
  - If the received message is not a protocol handshake request or is invalid (further details on the protocol handshake can be found under the 'Handshake' heading below), the `Connection` is closed immediately.
  - Upon receiving a valid protocol handshake request:
    - Follow the instructions for a successful handshake in the client scenario (this code path is identical).
    - Send a successful protocol handshake response back to the client.
- A close event listener is attached to the `Connection` to handle unexpected closures. This event listener should:
  - Close the underlying wire connection if still open.
  - Initiate the grace period for the associated `Session`'s destruction.

### Handshake

The handshake is a special message that is sent immediately after the wire connection is established and before any other messages are sent. 
Once a handshake is successful, the client and server can start sending and receiving messages, and a session is considered to be established.
Handshake messages are identical to normal transport messages except with:

1. `seq: 0`
2. `ack: 0`
3. no control flags

The handshake request payload schema is the following:

```ts
type HandshakeRequest = {
  type: 'HANDSHAKE_REQ';
  protocolVersion: string;
  instanceId: string;
};
```

The handshake response payload schema is the following:

```ts
type HandshakeResponse = {
  type: 'HANDSHAKE_RESP';
  status:
    | {
        ok: true;
        instanceId: string;
      }
    | {
        ok: false;
        reason: string;
      };
};
```

The server will send an error response if the handshake request is malformed (i.e. doesn't conform to the schema) or the protocol version in the request does not match the protocol version of the server.

When the client receives a status with `ok: false`, it should consider the handshake failed and close the connection.

### Transparent reconnections

River handles disconnections and reconnections in a transparent manner wherever possible.
To do this, it uses a combination of a send buffer, heartbeats, acknowledgements, and sequence numbers.
This metadata is tracked within the `Session` object.

Though this is very [TCP](https://jzhao.xyz/thoughts/TCP) inspired, River has the benefit of assuming the underlying transport is an ordered byte stream which simplifies the protocol significantly.

The send buffer is a queue of messages that have been sent but not yet acknowledged by the other side.
When a message is sent (including control messages like explicit acks[^1]), it is added to the send buffer.

[^1]:
    There is a protocol optimization here that treats explicit acks purely as status updates for bookkeeping.
    In this optimization, explicit heartbeats 1) should not be buffered, 2) should not increment `seq` when sent, 3) send `seq - 1` as its `seq` field.
    Semantically, this is identical to 'retransmitting' the previous message but without the payload.

All messages have an `ack` and the `ack` corresponds to the number of messages the other side has processed.
When receiving message a valid message (see the 'Handling Messages for Streams' section for the definition of 'valid'), sessions should ensure that the incoming message `msg.seq` MUST match the session's `session.ack`.
This helps to ensure exactly once delivery and ensures that duplicate and out-of-order messages don't mistakingly update the session's bookkeeping.

After validating the message, the session associated with the connection SHOULD update its bookkeeping by:

- Removing all messages from the send buffer that have an `seq` less than or equal to the `ack` of the received message.
- Setting the `ack` for the current session to be `seq + 1` of the received message.

When sending messages to the other side, the session associated with the connection SHOULD:

- Increment the `seq` for the session by 1.

When receiving messages, the transport MUST ensure that the only messages it validates are those that have a `seq` that is exactly equal to the `ack` of the session. This ensures exactly-once delivery semantics.

#### On disconnect

Handling close events is detailed in the 'Creating Connections and Sessions' section above.

When a connection is lost, the client and server should attempt to reconnect to the other side.
The client and server should both have a grace period for the other side to reconnect before considering the session lost.

It is important to note that this implies that there are two types of 'reconnects' in River:

1. Transparent reconnects: the connection dropped and reconnected but the session metadata is in-tact so resending the buffered messages will restore order. At the application level, nothing happened.
2. Hard reconnect: the other transport has lost all state and current transport should invalidate all state and start from scratch.

The TypeScript implementation of the transport explicitly emits `connectionStatus` events for transparent reconnects and `sessionStatus` events for hard reconnects which the client and server can listen to.

Both clients and servers should listen for `sessionStatus` events to do some error handling:

- All procedure calls must listen for `sessionStatus` events to handle hard disconnect. In the case of a hard disconnect, any ongoing procedure calls should return the special hard disconnect message `{ ok: false, payload: { code: 'UNEXPECTED_DISCONNECT' } }` to any waiting callers. This is a normal River result and should be handled by the application level.
- Servers should listen for `sessionStatus` events to cleanup any streams associated with the session and do any necessary teardown.

#### Detecting phantom disconnects

Certain transports will not emit a close event when the underlying connection is lost.
This is especially true for WebSockets in specific cases (e.g. closing your laptop lid).

To detect these phantom disconnects, the session SHOULD send an explicit heartbeat message every `heartbeatInterval` milliseconds (this should be a parameter of the transport).
This message is a control message with the `AckBit` set and the payload `{ type: 'ACK' }`.
The `seq` and `ack` of the message should match that of the session itself and otherwise be transmitted like a normal message.

This explicit ack serves three purposes:

1. It keeps the connection alive by preventing the underlying transport from timing out.
2. It allows the session to detect when the underlying transport has been lost, even in cases where the transport does not emit a close event.
3. It provides an upper bound on how many messages the session buffers in the case of a reconnection (consider the case where an upload procedure is really long-lived and the server doesn't send any messages until the upload is finished. Without these explicit heartbeats, the client will buffer everything!).
