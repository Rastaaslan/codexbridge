import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { configSchema } from "../src/config.js";
import { Store } from "../src/database.js";
import { GitWorkspace } from "../src/git.js";
import { Orchestrator } from "../src/orchestrator.js";
import { createApp } from "../src/server.js";
test("OAuth resource validates signature, subject, audience, scope and expiry", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid: "fixture",
    alg: "RS256",
    use: "sig",
  };
  const keys = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  }).listen(0, "127.0.0.1");
  await new Promise<void>((r) => keys.once("listening", r));
  const keysPort = (keys.address() as { port: number }).port;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codexbridge-oauth-"));
  const config = configSchema.parse({
    dataDir,
    port: 38475,
    token: "o".repeat(64),
    publicUrl: "https://codexbridge.example/mcp",
    oauthIssuer: "https://auth.example",
    oauthJwksUrl: `http://127.0.0.1:${keysPort}/jwks`,
    oauthSubject: "owner",
  });
  const store = new Store(path.join(dataDir, "codexbridge.db"));
  const core = new Orchestrator(
    config,
    store,
    new GitWorkspace(config),
    { async run() {} },
    {
      async review() {
        throw Error("unused");
      },
    },
  );
  const server = createApp(core).listen(config.port, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${config.port}`;
  const token = async (
    subject = "owner",
    audience = config.publicUrl!,
    scope = "codexbridge",
    expiry = "1m",
  ) =>
    new SignJWT({ scope })
      .setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(config.oauthIssuer!)
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt()
      .setExpirationTime(expiry)
      .sign(privateKey);
  const request = async (bearer: string) =>
    fetch(url + "/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + bearer,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "oauth-test", version: "1" },
        },
      }),
    });
  try {
    const metadata = (await (
      await fetch(url + "/.well-known/oauth-protected-resource")
    ).json()) as any;
    assert.equal(metadata.resource, config.publicUrl);
    const good = await request(await token());
    assert.equal(good.status, 200);
    await good.text();
    for (const bad of [
      await token("attacker"),
      await token("owner", "wrong"),
      await token("owner", config.publicUrl!, "other"),
      await token("owner", config.publicUrl!, "codexbridge", "-1m"),
      "forged",
    ]) {
      const r = await request(bad);
      assert.equal(r.status, 401);
      assert.match(r.headers.get("www-authenticate")!, /resource_metadata/);
      await r.text();
    }
  } finally {
    server.closeAllConnections();
    keys.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => keys.close(() => r()));
    store.close();
  }
});
