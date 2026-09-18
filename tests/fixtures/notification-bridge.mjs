import readline from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "notification-fixture", version: "1" } } });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "ping") {
    send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "client-specific" } });
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.id !== undefined) send({ jsonrpc: "2.0", id: message.id, result: {} });
});
