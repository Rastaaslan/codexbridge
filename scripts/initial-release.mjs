import { readFile, realpath } from "node:fs/promises";
import { makeDriver, validateRef } from "./self-update.mjs";
// Explicit one-time initialization. Never replaces an existing current release.
if (process.platform !== "linux" || process.getuid?.() === 0)
  throw Error("Run as codexbridge on Debian");
const ref = validateRef(process.argv[2]);
try {
  await realpath("/opt/codexbridge/current");
  throw Error("Initial release already exists; use self_update");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const config = JSON.parse(
  await readFile("/etc/codexbridge/update.json", "utf8"),
);
const driver = await makeDriver(
  "/opt/codexbridge",
  "/var/lib/codexbridge",
  config,
);
const release = await driver.build(ref);
await driver.activate(release);
console.log(
  "Initial release built and selected. Configure runtime, then start services and run doctor.",
);
