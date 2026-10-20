// A minimal client for `safaridriver --mcp` (stdio JSON-RPC, MCP): drives a tab of its own in Safari.
import { spawn } from "node:child_process";
export async function connect() {
  const p = spawn("safaridriver", ["--mcp"], { stdio: ["pipe", "pipe", "inherit"] });
  let buf = "", id = 0; const waiting = new Map();
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    }
  });
  const rpc = (method, params) => new Promise((res) => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "declare", version: "1" } });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return {
    rpc,
    tool: async (name, args) => { const r = await rpc("tools/call", { name, arguments: args }); if (r.error) throw new Error(JSON.stringify(r.error)); return r.result; },
    close: () => p.kill(),
  };
}
