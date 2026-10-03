import { writeFile } from "node:fs/promises";
import path from "node:path";

export async function createLiveCodexLauncher(
  directory: string,
  sessionHome: string,
  command = "codex",
) {
  // Explicit CommonJS extension is required inside this type=module package.
  const launcher = path.join(directory, "codex-launcher.cjs");
  await writeFile(
    launcher,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process');
const child = spawn(${JSON.stringify(command)}, process.argv.slice(2), {
  env: { ...process.env, CODEX_HOME: ${JSON.stringify(sessionHome)} }, stdio: 'inherit'
});
child.on('error', () => process.exit(1));
child.on('exit', code => process.exit(code ?? 1));
`,
    { mode: 0o700 },
  );
  return launcher;
}
