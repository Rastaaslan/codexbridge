import "dotenv/config";
import { execFileSync } from "node:child_process";
for (const name of [
  "CONTROL_PLANE_API_KEY",
  "OPENAI_API_KEY",
  "CODEXBRIDGE_HOME",
])
  console.log(name + ": " + (process.env[name] ? "configured" : "absent"));
try {
  console.log(
    execFileSync(
      process.platform === "win32" ? "where.exe" : "which",
      ["tunnel-client"],
      { encoding: "utf8", windowsHide: true },
    ),
  );
} catch {
  console.log("tunnel-client: not on PATH");
}
