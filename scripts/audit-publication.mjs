import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export function audit(root = process.cwd()) {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
  const findings = [];
  const forbidden =
    /(^|\/)(node_modules|dist|\.codexbridge|\.codex|\.secrets|secrets|logs|worktrees|runtime|releases|\.test-tmp|\.validation|upstream\.git)(\/|$)|(^|\/)\.env(?:\..*)?$|\.(?:db(?:-wal|-shm)?|sqlite3?(?:-wal|-shm)?|log|jsonl|pem|key|p12|pfx)$|(^|\/)(?:auth|config|tunnel-install|tunnel|update-request|update-status|maintenance)\.json$/i;
  const patterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/,
    /\bgh[pousr]_[A-Za-z0-9]{30,}/,
    /\bgithub_pat_[A-Za-z0-9_]{30,}/,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/,
    /(?:token|api[_-]?key|password|secret)\s*["']?\s*[:=]\s*["'][A-Za-z0-9_+\/=.-]{32,}["']/i,
  ];
  for (const file of [...new Set(files)].sort()) {
    if (file !== ".env.example" && forbidden.test(file))
      findings.push({ file, reason: "runtime/secret path" });
    const target = path.join(root, file);
    let stat;
    try {
      stat = lstatSync(target);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      findings.push({ file, reason: "symlink requires publication review" });
      continue;
    }
    if (!stat.isFile()) continue;
    const text = readFileSync(target, "utf8");
    for (const [index, line] of text.split(/\r?\n/).entries())
      if (patterns.some((p) => p.test(line)))
        findings.push({
          file,
          line: index + 1,
          reason: "possible credential; value withheld",
        });
  }
  return {
    ok: findings.length === 0,
    files: [...new Set(files)].sort(),
    findings,
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = audit();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
