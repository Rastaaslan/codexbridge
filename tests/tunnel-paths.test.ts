import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  resolveTunnelBinary,
  tunnelMcpCommand,
} from "../scripts/tunnel-paths.mjs";

test("Debian v0.0.15 resolves the extracted runtime binary instead of nonexistent tunnel-client", () => {
  const root = "/var/lib/codexbridge/bin/tunnel-client-v0.0.15";
  const binary = resolveTunnelBinary(
    { root, files: ["tunnel-client-runtime-cloudflared", "README.md"] },
    "linux",
  );
  assert.equal(binary, `${root}/tunnel-client-runtime-cloudflared`);
  assert.notEqual(binary, `${root}/tunnel-client`);
  assert.equal(
    resolveTunnelBinary(
      { root, files: ["bin/", "bin/tunnel-client-runtime-cloudflared"] },
      "linux",
    ),
    `${root}/bin/tunnel-client-runtime-cloudflared`,
  );
});

test("Windows v0.0.14 keeps its installed executable and local MCP command", () => {
  assert.equal(
    resolveTunnelBinary(
      {
        root: "C:\\bridge\\bin\\tunnel-client-v0.0.14",
        files: ["tunnel-client.exe", "README.md"],
      },
      "win32",
    ),
    "C:\\bridge\\bin\\tunnel-client-v0.0.14\\tunnel-client.exe",
  );
  assert.equal(
    tunnelMcpCommand({
      platform: "win32",
      managed: "1",
      cwd: "C:\\My Bridge",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
    }),
    '"C:/Program Files/nodejs/node.exe" "C:/My Bridge/dist/cli.js" mcp-stdio',
  );
});

test("binary resolution fails closed for missing, ambiguous or unsafe metadata", () => {
  const root = "/var/lib/codexbridge/bin/tunnel-client-v0.0.15";
  for (const files of [
    undefined,
    [],
    ["cloudflared"],
    ["tunnel-client", "tunnel-client-runtime-cloudflared"],
    ["../tunnel-client"],
    ["/tmp/tunnel-client"],
    ["C:\\tunnel-client"],
    ["bin\\tunnel-client"],
    ["tunnel-client\n"],
    [null],
  ]) {
    assert.throws(() => resolveTunnelBinary({ root, files }, "linux"));
  }
  assert.throws(() =>
    resolveTunnelBinary(
      { root: "relative", files: ["tunnel-client"] },
      "linux",
    ),
  );
});

test("managed Debian MCP command never uses the inaccessible /home/damien clone", () => {
  const command = tunnelMcpCommand({
    platform: "linux",
    managed: "1",
    cwd: "/home/damien/codexbridge",
    execPath: "/usr/bin/node",
  });
  assert.equal(
    command,
    '"/usr/bin/node" "/opt/codexbridge/current/dist/cli.js" mcp-stdio',
  );
  assert.doesNotMatch(command, /\/home\/damien/);
  assert.equal(
    tunnelMcpCommand({
      platform: "linux",
      managed: "0",
      cwd: "/home/damien/codexbridge",
      execPath: "/usr/bin/node",
    }),
    '"/usr/bin/node" "/home/damien/codexbridge/dist/cli.js" mcp-stdio',
  );
});

test("tunnel entrypoint uses validated binary and shared MCP command for setup and connect", async () => {
  const source = await readFile("scripts/tunnel.mjs", "utf8");
  assert.match(source, /const bin = resolveTunnelBinary\(installed\)/);
  assert.match(source, /const command = tunnelMcpCommand\(\)/);
  assert.equal((source.match(/"--mcp-command",\s+command/g) || []).length, 2);
  assert.match(source, /spawnSync\(bin, args,/);
});
