const readline = require("node:readline");
const fs = require("node:fs");
const input = readline.createInterface({ input: process.stdin });
const send = (message) =>
  process.stdout.write(`${JSON.stringify(message)}\n`);
const requests = [];

input.on("line", (line) => {
  const message = JSON.parse(line);
  requests.push(message);
  if (process.env.FAKE_CODEX_REQUEST_LOG) {
    fs.writeFileSync(process.env.FAKE_CODEX_REQUEST_LOG, JSON.stringify(requests));
  }
  send({ method: "test/received", params: message });
  if (message.id === undefined) return;

  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { userAgent: "fake-codex/1.0" } });
      break;
    case "thread/start":
      send({
        id: message.id,
        result: { thread: { id: "thread-1" }, cwd: message.params.cwd },
      });
      break;
    case "thread/resume":
      send({
        id: message.id,
        result: {
          thread: {
            id: message.params.threadId,
            status: { type: "active", activeFlags: [] },
            cwd: "/workspace",
            turns: [
              { id: "turn-recovered", status: "inProgress", items: [] },
            ],
          },
        },
      });
      setTimeout(() => {
        send({
          method: "item/completed",
          params: {
            threadId: message.params.threadId,
            turnId: "turn-recovered",
            item: {
              type: "agentMessage",
              id: "message-recovered",
              text: "recovered reply",
            },
          },
        });
        send({
          method: "turn/completed",
          params: {
            threadId: message.params.threadId,
            turn: { id: "turn-recovered", status: "completed" },
          },
        });
      }, 10);
      break;
    case "turn/start":
      send({
        id: message.id,
        result: { turn: { id: "turn-1", status: "inProgress" } },
      });
      send({
        method: "turn/started",
        params: {
          threadId: message.params.threadId,
          turn: { id: "turn-1", status: "inProgress" },
        },
      });
      break;
    case "turn/steer":
      send({ id: message.id, result: { turnId: "turn-1" } });
      break;
    case "turn/interrupt":
      send({ id: message.id, result: {} });
      break;
    default:
      send({ id: message.id, error: { code: -32601, message: "unknown" } });
  }
});
