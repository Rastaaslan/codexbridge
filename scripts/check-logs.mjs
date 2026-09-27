import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const root = path.resolve(process.env.CODEXBRIDGE_HOME || ".codexbridge");
const config = JSON.parse(
  await readFile(path.join(root, "config.json"), "utf8"),
);
const secrets = [
  ["CODEXBRIDGE_TOKEN", config.token],
  ...Object.entries(process.env).filter(
    ([key, value]) =>
      /TOKEN|KEY|SECRET|PASSWORD/i.test(key) &&
      !/^GIT_CONFIG_KEY_\d+$/.test(key) &&
      value.length > 7,
  ),
];
let checked = 0;
const roots = [root];
for (const kind of ["live-e2e", "live-recovery"])
  for (const name of await readdir(path.join(root, kind)).catch(() => []))
    roots.push(path.join(root, kind, name, "state"));
for (const dir of roots) {
  for (const name of await readdir(path.join(dir, "logs")).catch(() => [])) {
    const text = await readFile(path.join(dir, "logs", name), "utf8");
    const match = secrets.find(([, secret]) => text.includes(secret));
    if (match)
      throw Error(
        `Secret detected in log file: variable ${match[0]} (content withheld).`,
      );
    checked++;
  }
  try {
    const db = new DatabaseSync(path.join(dir, "codexbridge.db"), {
      readOnly: true,
    });
    for (const row of db.prepare("SELECT data FROM job_events").all()) {
      const match = secrets.find(([, secret]) =>
        String(row.data).includes(secret),
      );
      if (match)
        throw Error(
          `Secret detected in event journal: variable ${match[0]} (content withheld).`,
        );
      checked++;
    }
    db.close();
  } catch (e) {
    if (String(e).includes("Secret detected")) throw e;
  }
}
console.log(
  `Checked ${checked} log files / event records: no configured secret value found.`,
);
