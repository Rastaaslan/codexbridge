import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
export function redact(value: unknown): string {
  if (typeof value !== "string") {
    const clean = (input: unknown): unknown => {
      if (typeof input === "string") return redact(input);
      if (Array.isArray(input)) return input.map(clean);
      if (input && typeof input === "object")
        return Object.fromEntries(
          Object.entries(input).map(([key, item]) => [
            key,
            /^(authorization|password|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|token)$/i.test(
              key,
            )
              ? "[REDACTED]"
              : clean(item),
          ]),
        );
      return input;
    };
    return JSON.stringify(clean(value));
  }
  let text = value;
  for (const [key, secret] of Object.entries(process.env))
    if (/TOKEN|SECRET|KEY|PASSWORD/i.test(key) && secret && secret.length > 7)
      text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/\b(sk-[\w-]{12,}|Bearer\s+[\w.\-]+)/gi, "[REDACTED]")
    .replace(
      /(["']?(?:access_token|refresh_token|password|api_key|authorization)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
      '$1"[REDACTED]"',
    );
}
export function logger(dir: string) {
  mkdirSync(path.join(dir, "logs"), { recursive: true });
  return (
    level: "debug" | "info" | "warn" | "error",
    message: string,
    jobId?: string,
  ) =>
    appendFileSync(
      path.join(dir, "logs", `${new Date().toISOString().slice(0, 10)}.jsonl`),
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        jobId,
        message: redact(message),
      }) + "\n",
    );
}
