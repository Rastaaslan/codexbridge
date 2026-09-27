import "dotenv/config";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";

export const configSchema = z.strictObject({
  dataDir: z.string(),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(3847),
  repositoryRoots: z.array(z.string()).default([]),
  maxConcurrentJobs: z.number().int().min(1).max(10).default(10),
  codexCommand: z.string().default("codex"),
  model: z.string().optional(),
  reviewer: z.enum(["codex", "openai"]).default("codex"),
  reviewerModel: z.string().optional(),
  timeoutMs: z.number().int().min(1000).default(1800000),
  token: z.string().min(32),
  publicUrl: z.url().optional(),
  oauthIssuer: z.url().optional(),
  oauthJwksUrl: z.url().optional(),
  oauthSubject: z.string().optional(),
});
export type Config = z.infer<typeof configSchema>;
export function dataDirectory() {
  return path.resolve(process.env.CODEXBRIDGE_HOME || ".codexbridge");
}
export function setup() {
  const dir = dataDirectory();
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "config.json");
  if (!existsSync(file))
    writeFileSync(
      file,
      JSON.stringify(
        {
          dataDir: dir,
          repositoryRoots: [realpathSync(process.cwd())],
          maxConcurrentJobs: 10,
          token: randomBytes(32).toString("hex"),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  return file;
}
export function loadConfig(): Config {
  const dir = dataDirectory(),
    file = path.join(dir, "config.json");
  if (!existsSync(file))
    throw new Error("Configuration missing. Run codexbridge setup.");
  const c = configSchema.parse({
    ...JSON.parse(readFileSync(file, "utf8")),
    dataDir: dir,
    ...(process.env.CODEXBRIDGE_TOKEN
      ? { token: process.env.CODEXBRIDGE_TOKEN }
      : {}),
  });
  if (
    c.publicUrl &&
    (!c.publicUrl.startsWith("https://") ||
      !c.oauthIssuer?.startsWith("https://") ||
      !c.oauthJwksUrl?.startsWith("https://") ||
      !c.oauthSubject)
  )
    throw new Error(
      "Public MCP requires HTTPS, OAuth issuer, JWKS URL and an allowed subject.",
    );
  return c;
}
