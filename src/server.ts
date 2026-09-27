import express from "express";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcp, toolDefinitions } from "./tools.js";
import type { Orchestrator } from "./orchestrator.js";
import { errorMessage } from "./domain.js";
import { redact } from "./log.js";
import { spawn } from "node:child_process";
function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function createApp(core: Orchestrator, onStop: () => void = () => {}) {
  const app = express();
  const c = core.config;
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  const jwks = c.oauthJwksUrl
    ? createRemoteJWKSet(new URL(c.oauthJwksUrl))
    : null;
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    const hosts = new Set([
      `127.0.0.1:${c.port}`,
      `localhost:${c.port}`,
      `[::1]:${c.port}`,
      ...(c.publicUrl ? [new URL(c.publicUrl).host] : []),
    ]);
    if (!hosts.has(req.headers.host ?? "")) {
      res.status(403).json({ error: "Invalid Host" });
      return;
    }
    if (
      req.headers.origin &&
      ![
        "http://127.0.0.1:" + c.port,
        "http://localhost:" + c.port,
        ...(c.publicUrl ? [new URL(c.publicUrl).origin] : []),
      ].includes(req.headers.origin)
    ) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    next();
  });
  app.get("/health", (_req, res) =>
    res.json({ name: "codexbridge", status: "ok" }),
  );
  if (c.publicUrl)
    app.get("/.well-known/oauth-protected-resource", (_req, res) =>
      res.json({
        resource: c.publicUrl,
        authorization_servers: [c.oauthIssuer],
        scopes_supported: ["codexbridge"],
      }),
    );
  app.use(["/api", "/mcp"], async (req, res, next) => {
    const token = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (equal(token, c.token)) {
      next();
      return;
    }
    if (req.baseUrl === "/mcp" && jwks && c.publicUrl) {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: c.oauthIssuer,
          audience: c.publicUrl,
          algorithms: ["RS256", "ES256"],
        });
        if (
          payload.sub !== c.oauthSubject ||
          !String(payload.scope ?? "")
            .split(" ")
            .includes("codexbridge")
        )
          throw new Error("Scope or subject denied");
        next();
        return;
      } catch {}
    }
    res.set(
      "WWW-Authenticate",
      c.publicUrl
        ? `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource", c.publicUrl)}", scope="codexbridge"`
        : "Bearer",
    );
    res.status(401).json({ error: "Authentication required" });
  });
  app.post("/mcp", async (req, res, next) => {
    const server = createMcp(core),
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      next(e);
    }
  });
  app.all("/mcp", (_req, res) =>
    res
      .status(405)
      .json({ error: "Use Streamable HTTP POST; transport is stateless." }),
  );
  const definitions = toolDefinitions(core);
  app.post("/api/tools/:name", async (req, res, next) => {
    try {
      const tool = definitions.find((t) => t.name === req.params.name);
      if (!tool) {
        res.status(404).json({ error: "Unknown tool" });
        return;
      }
      res.json(
        JSON.parse(
          redact(tool.output.parse(await tool.run(tool.input.parse(req.body)))),
        ),
      );
    } catch (e) {
      next(e);
    }
  });
  app.get("/api/events/:id", (req, res, next) => {
    try {
      core.store.get(req.params.id);
      let cursor = Number(req.headers["last-event-id"] ?? req.query.after ?? 0);
      if (!Number.isSafeInteger(cursor) || cursor < 0)
        throw new Error("Invalid event cursor");
      res.set({
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      res.flushHeaders();
      const send = () => {
        for (const event of core.store.events(req.params.id, cursor, 500)) {
          cursor = Number(event.id);
          res.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
        }
      };
      send();
      const timer = setInterval(() => {
        send();
        res.write(": heartbeat\n\n");
      }, 1500);
      req.on("close", () => clearInterval(timer));
    } catch (e) {
      next(e);
    }
  });
  app.post("/api/stop", (_req, res) => {
    res.json({ stopping: true });
    setTimeout(onStop, 100);
  });
  app.post("/api/open-repository/:id", async (req, res, next) => {
    try {
      if (
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket.remoteAddress ?? "",
        )
      )
        throw new Error("Opening folders is local-only");
      const job = core.store.get(req.params.id);
      await core.git.repository(job.repository);
      if (job.worktree) await core.git.validate(job);
      const folder = job.worktree ?? job.repository;
      const child = spawn(
        process.platform === "win32"
          ? "explorer.exe"
          : process.platform === "darwin"
            ? "open"
            : "xdg-open",
        [folder],
        { shell: false, windowsHide: true, stdio: "ignore" },
      );
      child.once("error", next);
      child.once("spawn", () => {
        child.unref();
        res.json({ opened: folder });
      });
    } catch (e) {
      next(e);
    }
  });
  app.use(
    express.static(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public"),
    ),
  );
  app.use(
    (
      e: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (!res.headersSent)
        res.status(400).json({ error: redact(errorMessage(e)) });
    },
  );
  return app;
}
