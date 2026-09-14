# Raw protobuf handlers

Unary and server-streaming methods can opt into raw application payloads with `{ raw: handler }`.
Existing typed function handlers stay unchanged. Both forms use the original service and method descriptors.

```ts
const service = createProtoService().define(Greeter, {
  sayHello: {
    raw: async (request, ctx) => Ok(await forward(request, ctx.signal)),
  },
  serverStream: {
    raw: async ({ request, ctx, resWritable }) => {
      for await (const bytes of forwardStream(request, ctx.signal)) {
        if (!resWritable.isWritable()) return;
        if (!resWritable.write(Ok(bytes))) {
          await resWritable.waitForWriteReady();
        }
      }
      resWritable.close();
    },
  },
});
```

`request` and the successful response payload are `Uint8Array` values.
`forward` in this example is an application-supplied function that returns serialized bytes for the method's output message.
`forwardStream` yields serialized output messages and stops when the signal aborts.
Server-streaming handlers must close `resWritable` when they finish. Returning alone does not close the stream.
To send a typed failure after successful frames, use `resWritable.close(Err(error))`.
With `ProtoCodec`, those bytes occupy envelope field 11, exactly as they do for an equivalent typed response.
The generated client and the wire format do not change. Errors remain typed `Err` values, including metadata and detail bytes.

River still validates the opening envelope, routing names, byte container, and request-close bit.
It does not parse or validate a raw protobuf body. The raw handler or its upstream service must validate requests and produce valid response bytes.
Invalid response bytes can cause the client to stop consuming a stream without canceling the server producer.

Handler context, handshake handling, cancellation, and tracing stay native.
Middleware receives raw requests as `Uint8Array` in `reqInit`; middleware that reads message fields must narrow that union first.
`ServiceImpl` and `MethodImpl` retain their typed-only contracts. `ServiceHandlers` and `RawMethodImpl` describe raw-capable registrations.
