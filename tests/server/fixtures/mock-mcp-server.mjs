#!/usr/bin/env node
// Minimal stdin/stdout JSON-RPC 2.0 echo server for MCP pool tests.
// Reads line-delimited JSON from stdin; writes line-delimited JSON to stdout.
//
// Methods:
//   echo({...})           → result: { ok: true, echoed: <params> }
//   slow({ ms })          → resolves after `ms` ms with same shape
//   crash()               → process.exit(1) with no response
//   ping()                → result: "pong"
//
// Stderr writes are passthrough (visible in test output for debugging).

import { stdin, stdout, stderr, exit } from "node:process";

let buf = "";
const writeLine = (obj) => stdout.write(JSON.stringify(obj) + "\n");

stdin.setEncoding("utf-8");
stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      stderr.write(`[mock-mcp] parse error: ${e.message}\n`);
      continue;
    }
    handle(req);
  }
});

stdin.on("end", () => exit(0));

function handle(req) {
  const { id, method, params } = req;
  if (method === "crash") {
    stderr.write(`[mock-mcp] crashing on request id=${id}\n`);
    exit(1);
    return;
  }
  if (method === "slow") {
    const ms = Number(params?.ms ?? 50);
    setTimeout(() => writeLine({ jsonrpc: "2.0", id, result: { ok: true, echoed: params } }), ms);
    return;
  }
  if (method === "echo") {
    writeLine({ jsonrpc: "2.0", id, result: { ok: true, echoed: params } });
    return;
  }
  if (method === "ping") {
    writeLine({ jsonrpc: "2.0", id, result: "pong" });
    return;
  }
  writeLine({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
}
