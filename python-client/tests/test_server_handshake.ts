/**
 * Test server with handshake validation for Python client tests.
 *
 * Requires clients to send handshake metadata with {token: string}.
 * Valid token is "valid-token".
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { WebSocketServerTransport } from '../../transport/impls/ws/server';
import { createServer, createServiceSchema, Procedure, Ok } from '../../router';
import { createServerHandshakeOptions } from '../../router/handshake';
import { Type } from '@sinclair/typebox';
import { BinaryCodec } from '../../codec/binary';

const ServiceSchema = createServiceSchema();

const HandshakeTestServiceSchema = ServiceSchema.define({
  echo: Procedure.rpc({
    requestInit: Type.Object({ msg: Type.String() }),
    responseData: Type.Object({ response: Type.String() }),
    responseError: Type.Never(),
    async handler({ reqInit }) {
      return Ok({ response: reqInit.msg });
    },
  }),
});

const services = {
  test: HandshakeTestServiceSchema,
};

const handshakeSchema = Type.Object({ token: Type.String() });

async function main() {
  const httpServer = http.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      if (typeof addr === 'object' && addr) resolve(addr.port);
      else reject(new Error("couldn't get port"));
    });
  });

  const wss = new WebSocketServer({ server: httpServer });
  const serverTransport = new WebSocketServerTransport<typeof handshakeSchema>(
    wss,
    'HANDSHAKE_SERVER',
    { codec: BinaryCodec },
  );
  const _server = createServer(serverTransport, services, {
    handshakeOptions: createServerHandshakeOptions(
      handshakeSchema,
      (metadata) => {
        if (metadata.token !== 'valid-token') {
          return 'REJECTED_BY_CUSTOM_HANDLER' as const;
        }

        return {};
      },
    ),
  });

  process.stdout.write(`RIVER_PORT=${port}\n`);

  process.on('SIGTERM', () => {
    void _server.close().then(() => {
      httpServer.close();
      process.exit(0);
    });
  });
  process.on('SIGINT', () => {
    void _server.close().then(() => {
      httpServer.close();
      process.exit(0);
    });
  });
}

main().catch((err: unknown) => {
  console.error('Failed to start handshake test server:', err);
  process.exit(1);
});
