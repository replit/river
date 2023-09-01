import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { WebSocketTransport } from "../transport/ws";
import { Transport, TransportMessage } from "../transport/types";

async function createWebSocketServer(port: number) {
  const server = http.createServer();
  const wss = new WebSocket.Server({ server });
  return new Promise<[http.Server, WebSocketServer]>((resolve) => {
    server.listen(port, () => resolve([server, wss]));
  });
}

async function waitForSocketReady(socket: WebSocket) {
  return new Promise<void>((resolve) => {
    socket.addEventListener("open", () => resolve());
  });
}

async function createWebSocketClient(port: number) {
  const client = new WebSocket(`ws://localhost:${port}`);
  await waitForSocketReady(client);
  return client;
}

async function waitForMessage(t: Transport) {
  return new Promise((resolve, _reject) => {
    function onMessage(msg: TransportMessage) {
      resolve(msg.payload);
      t.removeMessageListener(onMessage);
    }

    t.addMessageListener(onMessage);
  });
}

const port = 3000;
describe("sending and receiving across websockets works", () => {
  let server: http.Server;
  let wss: WebSocketServer;
  beforeAll(async () => {
    [server, wss] = await createWebSocketServer(port);
  });

  afterAll((done) => {
    wss.clients.forEach((socket) => {
      socket.close();
    });
    server.close(done);
  });

  test("basic send/receive", async () => {
    let serverTransport: WebSocketTransport | undefined;
    wss.on("connection", (conn) => {
      serverTransport = new WebSocketTransport(conn, "server");
    });

    const clientSoc = await createWebSocketClient(port);
    const clientTransport = new WebSocketTransport(clientSoc, "client");

    const msg = {
      msg: "cool",
      test: 123,
    };

    clientTransport.send({
      id: "1",
      from: "client",
      to: "server",
      serviceName: "test",
      procedureName: "test",
      payload: msg,
    });

    expect(serverTransport).toBeTruthy();
    return expect(waitForMessage(serverTransport!)).resolves.toStrictEqual(msg);
  });
});
