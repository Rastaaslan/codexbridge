import { readdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const root = path.resolve(".codexbridge/live-e2e");
const latest = (await readdir(root)).sort().at(-1)!;
const db = new DatabaseSync(path.join(root, latest, "state/codexbridge.db"));
for (const row of db
  .prepare("SELECT type,data FROM job_events ORDER BY id DESC LIMIT 8")
  .all())
  console.log(row.type, String(row.data).slice(0, 2200));
db.close();
