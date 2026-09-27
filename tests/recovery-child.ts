import { Store } from "../src/database.js";
import { GitWorkspace } from "../src/git.js";
import { configSchema } from "../src/config.js";
import { createSchema } from "../src/domain.js";
import path from "node:path";
const [dataDir, repo] = process.argv.slice(2);
const c = configSchema.parse({
  dataDir,
  repositoryRoots: [repo],
  token: "r".repeat(64),
});
const store = new Store(path.join(dataDir, "codexbridge.db"));
const workspace = new GitWorkspace(c);
const j = store.create(
  createSchema.parse({
    title: "Crash fixture",
    ticket: "Fix add",
    repository: repo,
  }),
);
store.transition(j.id, "PREPARING");
const plan = await workspace.plan(j);
store.patch(j.id, plan);
await workspace.prepare(store.get(j.id));
store.thread(j.id, "persisted-before-kill");
store.transition(j.id, "CODEX_RUNNING", { iteration: 1 });
console.log("READY " + j.id);
setInterval(() => {}, 1000);
