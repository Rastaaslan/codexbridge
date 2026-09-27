import { mkdir, cp, access } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { git } from "../dist/git.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const config = loadConfig(),
  repo = path.join(config.dataDir, "chatgpt-fixture");
let exists = true;
try {
  await access(path.join(repo, ".git"));
} catch {
  exists = false;
}
if (!exists) {
  await mkdir(repo, { recursive: true });
  await cp("fixtures/add", repo, { recursive: true });
  await git(repo, ["init"]);
  await git(repo, ["config", "user.name", "CodexBridge Validation"]);
  await git(repo, ["config", "user.email", "validation@example.invalid"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "Intentionally broken addition"]);
}
const client = new Client({ name: "codexbridge-demo", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${config.port}/mcp`),
    { requestInit: { headers: { Authorization: "Bearer " + config.token } } },
  ),
);
try {
  const response = await client.callTool({
    name: "create_job",
    arguments: {
      title: "Validation ChatGPT — corriger addition",
      ticket:
        "Corriger add(a,b) pour renvoyer la somme exacte. Ajouter des tests pour les nombres négatifs, zéro et décimaux. Exécuter node --test et rapporter les résultats.",
      repository: repo,
      acceptanceCriteria: [
        "add(2,2) retourne 4",
        "Les tests négatifs, zéro et décimaux passent",
        "Le dépôt principal reste intact",
      ],
      options: { maxIterations: 5, idempotencyKey: "chatgpt-validation-v1" },
    },
  });
  if (response.isError) throw Error(JSON.stringify(response.content));
  console.log(
    JSON.stringify(
      {
        id: response.structuredContent.job.id,
        repository: repo,
        status: response.structuredContent.job.status,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
