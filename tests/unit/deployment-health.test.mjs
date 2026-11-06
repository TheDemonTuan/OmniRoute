import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, copyFile, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const siblings = [
  "peer-stamp.mjs", "main-server-timeouts.mjs", "systemd-notify.mjs",
  "http-method-guard.cjs", "head-response-guard.cjs", "h2c-upgrade-guard.cjs",
  "responses-ws-proxy.mjs", "webdav-handler.mjs", "tls-options.mjs",
];

test("deployment drain stays busy through streaming, aborts and upgraded sockets", { timeout: 15000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "omniroute-deployment-"));
  let child;
  let stream;
  let socket;
  try {
    for (const file of siblings) await copyFile(path.join(root, "scripts/dev", file), path.join(dir, file));
    await copyFile(path.join(root, "src/shared/utils/httpClientAbortGuard.mjs"), path.join(dir, "httpClientAbortGuard.mjs"));
    await copyFile(path.join(root, "scripts/dev/standalone-server-ws.mjs"), path.join(dir, "server-ws.mjs"));
    await writeFile(path.join(dir, "server.js"), `
const http = require("node:http");
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/health")) return res.end(JSON.stringify(globalThis.__omnirouteDeploymentRequests));
  if (req.url === "/stream") { res.writeHead(200); res.write("started"); return; }
  res.end("complete");
});
server.on("upgrade", (_req, socket) => {
  socket.on("end", () => socket.destroy());
  socket.write("HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: probe\\r\\n\\r\\n");
});
server.listen(0, "127.0.0.1", () => console.log("PORT " + server.address().port));
`);
    const env = { ...process.env, DEPLOY_SLOT: "blue" };
    delete env.NOTIFY_SOCKET;
    delete env.NEXT_MANUAL_SIG_HANDLE;
    child = spawn(process.execPath, ["server-ws.mjs"], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    let logs = "";
    child.stderr.on("data", (data) => { logs += data; });
    const port = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("server startup timeout: " + logs)), 5000);
      child.once("exit", () => { clearTimeout(timer); reject(new Error("server exited: " + logs)); });
      child.stdout.on("data", (data) => {
        output += data;
        const match = /PORT (\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const active = async () => (await (await fetch(base + "/api/health?probe=1")).json()).active;
    const waitForIdle = async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (await active() === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.fail("drain count never returned to zero");
    };
    assert.equal(await active(), 0, "health probes must not count themselves");
    stream = http.get(base + "/stream");
    const [response] = await once(stream, "response");
    await once(response, "data");
    assert.equal(await active(), 1, "returning from a handler must not release an open stream");
    response.destroy();
    stream.destroy();
    await waitForIdle();
    await (await fetch(base + "/complete")).text();
    await waitForIdle();
    socket = net.connect(port, "127.0.0.1");
    await once(socket, "connect");
    socket.write("GET /upgrade-probe HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: probe\r\n\r\n");
    const [handshake] = await once(socket, "data");
    assert.match(handshake.toString(), /101 Switching Protocols/);
    assert.equal(await active(), 1, "upgraded sockets must block drain until closed");
    socket.destroy();
    await waitForIdle();
  } finally {
    stream?.destroy();
    socket?.destroy();
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
