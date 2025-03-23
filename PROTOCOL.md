# River protocol `v2.0`

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
A procedure declares its type (`rpc | stream | upload | subscription`), an initial message (`Init`), a response message type (`Response`), an error type (`Error`), and the associated handler. `upload` and `stream` may define an request message type (`Request`), which means they accept further messages from the client.

_Note: all types in this document are expressed roughly in TypeScript._

The type signatures (in TypeScript) for the handlers of each of the procedure types are as follows:

- `rpc`: `Init -> Result<Response, Error>`
- `upload`: `Init, Readable<Request> -> Result<Response, Error>`
- `subscription`: `Init -> Writable<Result<Response, Error>>`
- `stream`: `Init, Readable<Request> -> Writable<Result<Response, Error>>`

The types of `Init`, `Request`, `Response`, and `Error` MUST be representable as JSON schema.
In the official TypeScript implementation, this is done via [TypeBox](https://github.com/sinclairzx81/typebox).
The server is responsible for doing run-time type validation on incoming messages to ensure they match the handler's type signature before passing it to the handler.

Additionally, the type of `Error` MUST implement the `BaseError` type:

```ts
interface BaseError {
  // This should be a defined literal to make sure errors are easily differentiated
  code: string;
  // This can be any string
  message: string;
  // Any extra metadata
  extra?: any;
}
```

The `Result` type MUST conform to:

```ts
type Result<SuccessPayload, ErrorPayload extends BaseError> =
  | { ok: true; payload: SuccessPayload }
  | { ok: false; payload: ErrorPayload };
```

The messages in either direction must also contain additional information so that the receiving party knows where to route the message payload. This wrapper message is referred to as a `TransportMessage` and its payload can be a `Control`, a `Result`, an `Init`, an `Request`, or an `Response`. The schema for the transport message is as follows:

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
  // - `Init` or `Request` in the client to server direction
  // - `Result<Response, Error>` in the server to client direction
  // - `Control` in either direction
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
```

A single 'invocation' of a handler is assigned a unique `streamId`, which is used to label all inbound and outbound messages associated with that invocation (this grouping is referred to as a 'procedure stream' or 'stream').

The `controlFlags` property is a [bit field](https://en.wikipedia.org/wiki/Bit_field) used to signal special conditions, such as the start of a stream, the end of the stream, and an explicit acknowledgement message.

- The `AckBit` (`0b00001`) MUST only be set in the case of an explicit heartbeat that _only_ contains ack/seq information and no application-level payload (i.e., only used to update transport level bookkeeping).
- The `StreamOpenBit` (`0b00010`) MUST be set for the first message of a new stream.
- The `StreamCancelBit` (`0b00100`) MUST be set when a stream is to be abruptly closed due to cancellations or an internal error condition.
- The `StreamClosedBit` (`0b01000`) MUST be set for the last message of a stream.

All messages MUST have no control flags set (i.e., the `controlFlags` field is `0b00000`) unless:

- It is the first message of a new stream, in which case the `StreamOpenBit` MUST be set.
  - The first message of a stream MUST be initiated from the client.
  - The client MUST also generate a unique `streamId` for the message, which will be constant throughout the lifetime of the stream.
  - The client must set `serviceName` and `procedureName` as the correct string for the associated service and procedure.
    - All further messages MAY omit `serviceName` and `procedureName` as they are implied by the first message and are constant throughout the lifetime of a stream.
- It is the last message of a stream, in which case the `StreamClosedBit` MUST be set.
  - If this is sent with no payload, it is a control message the payload MUST Be a `ControlClose`.
- It is a message cancelling the stream, in which case the `StreamCancelBit` MUST be set.
  - This message MUST contain a `ProtocolError` payload.
- It is an explicit heartbeat, so the `AckBit` MUST be the only bit set.
  - The payload MUST be `{ type: 'ACK' }`.
  - Because this is a control message that is not associated with a specific stream, you MUST NOT set `serviceName` or `procedureName` and `streamId` can be something arbitrary (e.g. `heartbeat`).

There are 4 error payloads that are defined in the protocol sent from server to client, these codes are reserved:

```ts
// When a client sends a malformed request. This can be
// for a variety of reasons which would  be included
// in the message.
interface InvalidRequestError extends BaseError {
  code: 'INVALID_REQUEST';
  message: string;
}

// This is sent when an exception happens in the handler of a stream.
interface UncaughtError extends BaseError {
  code: 'UNCAUGHT_ERROR';
  message: string;
}

// This is sent when one side wishes to cancel the stream
// abruptly from user-space. Handling this is up to the procedure
// implementation or the caller.
interface CancelError extends BaseError {
  code: 'CANCEL';
  message: string;
}

// This is sent when the server encounters an internal error
// i.e. an invariant has been violated
interface;

type ProtocolError = UncaughtError | InvalidRequestError | CancelError;
```

`ProtocolError`s, just like service-level errors, are wrapped with a `Result`, which is further wrapped with `TransportMessage` and MUST have a `StreamCancelBit` flag. Please note that these are separate from user-defined errors, which should be treated just like any response message.

There are 4 `Control` payloads:

```ts
// Used in cases where we want to send a close without
// a payload. MUST have a `StreamClosedBit`
interface ControlClose {
  type: 'CLOSE';
}

// Heartbeat messages. MUST have an `AckBit` flag
interface ControlAck {
  type: 'ACK';
}

interface ControlHandshakeRequest {
  type: 'HANDSHAKE_REQ';
  protocolVersion: 'v0' | 'v1' | 'v1.1' | 'v2.0';
  sessionId: string;
  expectedSessionState: {
    nextExpectedSeq: number; // integer
    nextSentSeq: number; // integer
  };
  metdata?: unknown;
}

interface ControlHandshakeResponse {
  type: 'HANDSHAKE_RESP';
  status:
    | {
        ok: true;
        sessionId: string;
      }
    | {
        ok: false;
        reason: string;
        code: // retriable
        | 'SESSION_STATE_MISMATCH'
          // fatal
          | 'MALFORMED_HANDSHAKE_META'
          | 'MALFORMED_HANDSHAKE'
          | 'PROTOCOL_VERSION_MISMATCH'
          | 'REJECTED_BY_CUSTOM_HANDLER';
      };
}

type Control =
  | ControlClose
  | ControlAck
  | ControlHandshakeRequest
  | ControlHandshakeResponse;
```

`Control` is a payload that is wrapped with `TransportMessage`.

## Streams

Streams tie together a series of messages into a single logical 'stream' of communication associated with a single remote procedure invocation.
For example, in the case of a `stream` RPC, the client will send a series of messages with the same `streamId`, and the server must respond with a series of messages with the same `streamId`.

### Starting streams

Streams MUST only be started by the client through the invocation of a procedure.
Once a procedure is invoked, it opens a new stream and sends the first message of the stream (in accordance with the 'Sending Messages' heading below) and listen to messages on that same `streamId`.

### Reader and Writer Semantics

All procedure types (`rpc`, `stream`, `upload`, `subscription`) are powered by bidirectional streams in the underlying protocol, but they are exposed differently at the API level and have different constraints on the number of messages sent and received. Bidirectional stream implies that for a given procedure, there are 2 pipes, a request pipe and a response pipe. The client has the writer end of the request pipe, while the server has the reader of the request pipe, conversely, the server has
the writer end of the response pipe, while the client has the reader end of the response pipe.

```
                Stream/Procedure Invocation

    Client                                     Server

┌──────────────┐                             ┌──────────────┐
│              │                             │              │
│   Request    │ ────────Request Pipe──────> │    Request   │
│   Writer     │                             │    Reader    │
│              │                             │              │
└──────────────┘                             └──────────────┘

┌──────────────┐                             ┌──────────────┐
│              │                             │              │
│   Response   │ <───────Response Pipe────── │   Response   │
│   Reader     │                             │   Writer     │
│              │                             │              │
└──────────────┘                             └──────────────┘
```

While `Init` is technically a "request", you want to treat it differently and pass it along to the handler without involving the request pipe.

ONLY the writer end can close the pipe, the reader can only choose to stop reading.

Streams can be in a half-closed state. This happens when one party sends a close signal indicating that it will no longer send
any more data on the relevant pipe, but it can still receive data from the other side on the other pipe.
In terms of readers and writers, the closing party's writer is closed but its reader is still open, and on the other side the reader
is closed but the writer is open. This is useful when, for example, the client has finished sending its data but is still expecting
a response from the server.

A full-close is when both sides close their writers, or when a cancellation happens which results in an immediate full-close.

### Handling messages for streams

#### Both client and server

When a message is received, it MUST be validated before being processed.

- Match the JSON schema for the `TransportMessage` type.
- Have an existing session for the transport `clientId` in the `from` field (see the 'Transports, Sessions, and Connections' heading for more information on sessions and transports).
- The `to` field of the message MUST match the transport's `clientId`.
- Have the expected `seq` number (see the 'Handling Transparent Reconnections' heading for more information on seq/ack).
- Is not an explicit heartbeat (i.e. the `AckBit` is not set).
- Either side can initiate a close by sending a message with a `StreamClosedBit`
  - The closing party MUST NOT send any more messages.
  - To get a full close, the other side MUST respond with a `StreamClosedBit` acknowledging the close.
- In case of errors or if one side wishes to abruptly cancel the stream, a message with a `StreamCancelBit` and a `ProtocolError` payload.

When a message is validated at this level, the implementor must update the bookkeeping information for the session (see the 'Transparent Reconnections' heading for more information).

Then, depending on whether this is a client or server, the message must undergo further validation before being handled.

#### On the client

For an incoming message to be considered valid on the client, the transport message MUST fulfill the following criteria:

- It should have a `streamId` that the client recognizes. That is, there MUST already be a message listener waiting for messages on the `streamId` of the original request message (recall that streams are only initiated by clients).
- If a server sends an `ProtocolError` message the client MUST NOT send any further messages to the server for that stream including a control messages.

If the message is invalid, the client MUST silently discard the message.
Otherwise, this is a normal message. Unwrap the payload and return it to the caller of the original procedure.

In cases where the incoming message is a `ControlClose` message, the client MUST end the user-facing response stream (see the section below on 'Lifetime of Streams' for more information on when these explicit close messages are sent). The message MUST NOT be passed to the user-facing response stream.

#### On the server

For an incoming message to be considered valid on the server, the transport message MUST fulfill the following criteria:

- It should match the JSON schema for the `TransportMessage` type.
- If the message has the `StreamOpenBit` set, it MUST have a `serviceName` and `procedureName`. The server MUST open a new stream and start a new instantiation of the handler for the specific `serviceName` and `procedureName`. The server should maintain a mapping of `streamId` to the handler instantiation so that future messages with the same `streamId` can be routed to the correct instantiation of the handler.
- If the message does not have the `StreamOpenBit` set, it MUST have a `streamId` that the server recognizes and has an associated handler open for.
- If this is the first message of the stream, the message should have `StreamOpenBit` and the internal payload of the message should match the JSON schema for the `Init` type of the associated handler, and the server should pass the `Init` message to the handler.
- If this is not the first message of the stream AND the procedure accepts further requests, the internal payload of the message should match the JSON schema for the `Request` type of the associated handler, and the server should pass the `Request` message to the handler.

If the message is invalid, the server MUST discard the message and send back an `INVALID_REQUEST` error message with a `StreamCancelBit`, this is an abrupt full close, the server should cleanup all associated resources with the stream without expecting a close response from the client. The server may choose to keep track of `INVALID_REQUEST` stream ids to avoid sending multiple errors back.

Otherwise, the message is a normal message. Unwrap the payload and pass it to the handler associated with the `streamId` of the message.

In cases where the incoming message is a `ControlClose` message, the server should close the request readable for the handler. The message MUST NOT be passed to the handler.

#### Lifetime of streams

The following section will provide diagrams detailing the lifetime of streams for each of the four types of RPCs.

The legend is as follows:

- `>` represents an `Init` message with the `StreamOpenBit` set.
- `x` represents an `Init` message with both `StreamOpenBit`and `StreamClosedBit` set.
- `<` represents a `Result` message with the `StreamClosedBit` set.
  - This message may contain service-level errors.
- `!` represents a `Result` message with the `StreamCancelBit` set and a `ProtocolError` in the payload.
- `{` represents a `ControlClose` message.
- `-` represents any message with no control flags set.

As other `Control` messages are unrelated to the stream lifecycle, they will not be included in the diagrams.

The diagrams don't differentiate readers and writers as it does not matter for the lifecycle of the stream. You can assume if a message is sent,
it is sent by the writer, and if a stream is closed, it is closed by the writer.

##### RPC

An `rpc` procedure starts with the client sending a single message with `StreamOpenBit` set and `StreamClosedBit` set and waits for a response message which MUST contain a `StreamClosedBit`.

Typical request:

```
client: x
server:  <
```

Protocol error:

```
client: x
server:  !
```

##### Stream

A `stream` procedure starts with the client sending a single message with the `StreamOpenBit` set. The client or server initiates a close by sending a final `ControlClose` message, the initiator MUST continue to accept data until the other side sends a `ControlClose` message.

Note that either side may choose to independently send a message at any time while their side is still open.

Client initiated close:

```
client: > --  - {
server:  -  -- - -- {
```

Server initiated close:

```
client: > --  -- -- {
server:  -  --  {
```

Protocol error (abrupt close):

```
client: > --  -   (any further messages are ignored)
server:  -  -- - !
```

##### Upload

An `upload` procedure starts with the client sending a single message with `StreamOpenBit` set and remains open until the client manually closes the request stream by sending `CloseControl` message. The server MUST send a final `Result` message with the `StreamClosedBit`.

Client finalizes upload:

```
client: > --  - {
server:          <
```

Protocol error (abrupt close):

```
client: > --  -   (any further messages are ignored)
server:         !
```

Client finalizes upload, leading to a protocol error (abrupt close):

```
client: > --  - {
server:          !
```

##### Subscription

A `subscription` procedure starts with the client sending a single message with the `StreamOpenBit` set and remains open until either side ends the stream by sending a `ControlClose` message. The party receiving the `ControlClose` message must respond with a final `CloseControl` message. If the client initiates the closing, it MUST continue to accept data until the other side sends a `ControlClose` message.

Client initiated close:

```
client: >       {
server:  -  -- - -- {
```

Server initiated close:

```
client: >         {
server:  -  -- - {
```

Protocol error (abrupt close):

```
client: >       (any further messages are ignored)
server:  -  -- !
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

### Why distinguish between `Transport` and `Session`?

The distinction between `Transport` and `Session` is important because it allows us to have transparent reconnections.

This means even if the actual wire connection drops, the client and server can buffer messages on both sides until the connection is re-established.
At the application level, it appears as if the connection never dropped.

### Creating connections and sessions

A `Connection` object MUST be created immediately upon establishing a raw wire connection.
Subsequently, a `Session` object is created for each `Connection` object to handle the lifecycle of the `Connection`.
The process differs slightly between the client and server:

#### Client

- The protocol handshake is initiated and sent as soon as the `Connection` is created, followed by attaching a message listener to the `Connection`.
  - Initially, only protocol handshake responses are listened for. (Further details on the protocol handshake can be found under the 'Handshake' heading below).
  - If the handshake fails, the `Connection` is closed immediately.
    - If the server detected a session state mismatch, any previous `Session`s will be destroyed.
  - Otherwise, consider the handshake successful and proceed to the next step.
  - The client should check for an existing `Session` for the `clientId` associated with the `Connection`.
    - If an existing `Session` is found and that `Session`, it is verified whether the last `sessionId` associated with the previous `Session` matches the `sessionId` in the handshake response.
      - A match in `sessionId` means a reconnection to the same session, and that the server still has the state for this session.
        - The stale `Connection` object associated with the `Session` is closed, and replaced with the new `Connection` object.
        - Any buffered messages are resent.
      - If they do not match, it indicates the server has lost the session state. The old session is removed, its `Connection` object and heartbeat are closed, and processing falls through to the case of not having an associated session.
    - If no associated session exists, a new `Session` object is created for the `Connection` and associated with each other.
  - After a successful handshake, the protocol handshake listener is removed and replaced with the regular message listener.
- A close event listener is attached to the `Connection` to handle unexpected closures. This event listener should:
  - Close the underlying wire connection if still open.
  - Initiate the grace period for the associated `Session`'s destruction.
    - If the connection for the same session is re-established, cancel the grace timer.
    - After the grace period has elapsed, consider the session and connection dead. Close the connection, stop the grace timer, stop trying to heartbeat, and delete all state associated with the session.
  - Attempt to reconnect to the server.

#### Server

- A message listener is attached to the `Connection` as soon as it is created.
  - Initially, only protocol handshake requests are listened for.
  - If the received message is not a protocol handshake request or is invalid (further details on the protocol handshake can be found under the 'Handshake' heading below), the `Connection` is closed immediately.
  - Upon receiving a valid protocol handshake request:
    - Follow the instructions for a successful handshake in the client scenario (this code path is identical).
    - Create a session with the same ID as the client session.
    - Send a successful protocol handshake response back to the client.
- A close event listener is attached to the `Connection` to handle unexpected closures. This event listener should:
  - Close the underlying wire connection if still open.
  - Initiate the grace period for the associated `Session`'s destruction (this code path is identical to the client).

#### State Transitions

- SessionNoConnection is the client entrypoint as we know who the other side is already, we just need to connect
- SessionWaitingForHandshake is the server entrypoint as we have a connection but don't know who the other side is yet

```plaintext
                           1. SessionNoConnection         ◄──┐
                           │  reconnect / connect attempt    │
                           ▼                                 │
                           2. SessionConnecting              │
                           │  connect success  ──────────────┤ connect failure
                           ▼                                 │
                           3. SessionHandshaking             │
                           │  handshake success       ┌──────┤ connection drop
 5. WaitingForHandshake    │  handshake failure  ─────┤      │
 │  handshake success      ▼                          │      │ connection drop
 ├───────────────────────► 4. SessionConnected        │      │ heartbeat misses
 │                         │  invalid message  ───────┼──────┘
 │                         ▼                          │
 └───────────────────────► x. Destroy Session   ◄─────┘
   handshake failure
```

### Handshake

The handshake is a special message that is sent immediately after the wire connection is established and before any other messages are sent.
The client and the server should both have a grace period `handshakeTimeoutMs` to wait for a valid handshake message before closing the connection.

Once a handshake is successful, the client and server can start sending and receiving messages, and a session is considered to be established.
Handshake messages are identical to normal transport messages except with:

1. `seq: 0`
2. `ack: 0`
3. no control flags

The full handshake request and response payload schemas are defined above in the `Control` payload documentation.

The server will send an error response if either:

- the handshake request is malformed (i.e. doesn't conform to the schema)
- the protocol version in the request does not match the protocol version of the server
- the expected session state does not match the server's session state. examples:
  - the client wanted a reconnection to a specific session but the server doesn't know about it
  - the client is in the future (`client.nextSentSeq > server.ack`)
  - server is in the future (`server.seq > client.nextExpectedSeq`)

When the client receives a status with `ok: false`, it should consider the handshake failed and close the connection.

### Transparent reconnections

River handles disconnections and reconnections in a transparent manner wherever possible when
explicitly requested.
To do this, it uses a combination of a send buffer, heartbeats, acknowledgements, and sequence numbers.
This metadata is tracked within the `Session` object.

Though this is very [TCP](https://jzhao.xyz/thoughts/TCP) inspired, River has the benefit of assuming the underlying transport is an ordered byte stream which simplifies the protocol significantly.

The send buffer is a queue of messages that have been sent but not yet acknowledged by the other side.
When a message is sent (including `Control` messages like explicit acks), it is added to the send buffer.

All messages have an `ack` and the `ack` corresponds to the number of messages the other side has processed.
When receiving message a valid message (see the 'Handling Messages for Streams' section for the definition of 'valid'), sessions should ensure that the incoming message `msg.seq` MUST match the session's `session.ack`.
This helps to ensure exactly once delivery and ensures that duplicate and out-of-order messages don't mistakingly update the session's bookkeeping.

After validating the message, the session associated with the connection SHOULD update its bookkeeping by:

- Removing all messages from the send buffer that have an `seq` strictly less than the `ack` of the received message.
- Setting the `ack` for the current session to be `seq + 1` of the received message.

When sending messages to the other side, the session associated with the connection SHOULD:

- Increment the `seq` for the session by 1.

When receiving messages, the transport MUST ensure that the only messages it validates are those that have a `seq` that is exactly equal to the `ack` of the session.
This ensures exactly-once delivery semantics.

#### On disconnect

Handling close events is detailed in the 'Creating Connections and Sessions' section above.

When a connection is lost, the client and server should attempt to reconnect to the other side.
The client and server should both have a grace period `sessionDisconnectGraceMs` for the other side to reconnect before considering the session as dead.

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

To detect these phantom disconnects, the server SHOULD send an explicit heartbeat message every `heartbeatIntervalMs` milliseconds (this should be a parameter of the transport) via each session.
This is because clients are usually browsers which means we cannot trust user-facing timers (due to various reasons like browser throttling, hibernation, etc.) so we rely purely on the server to track time.

This message is a `ControlAck` message.
The `seq` and `ack` of the message should match that of the session itself and otherwise be transmitted like a normal message (i.e. should stil increment bookkeeping like incrementing `seq`).

Clients SHOULD echo back a heartbeat in the same format as soon as it receives a server heartbeat.

We track the number of heartbeats that we've sent to the other side without hearing a message. When the number of heartbeat misses exceeds some threshold `heartbeatsUntilDead` (also a parameter of the transport),
close the connection in that session. See the 'On disconnect' section above for more details on how to handle this.

This explicit ack serves three purposes:

1. It keeps the connection alive by preventing the underlying transport from timing out.
2. It allows the session to detect when the underlying transport has been lost, even in cases where the transport does not emit a close event.
3. It provides an upper bound on how many messages the session buffers in the case of a reconnection (consider the case where an upload procedure is really long-lived and the server doesn't send any messages until the upload is finished. Without these explicit heartbeats, the client will buffer everything!).
