// Linux runs in the foreground; the legacy Windows CLI supervises its own daemon.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { foreground } from "./tunnel-linux.mjs";
const exec = promisify(execFile);
const script = fileURLToPath(new URL("./tunnel.mjs", import.meta.url));
if (process.platform === "linux") {
  process.exitCode = await foreground(
    process.execPath,
    [script, "connect"],
    process.env,
  );
} else {
  const invoke = (action) =>
    exec(process.execPath, [script, action], {
      timeout: 20000,
      maxBuffer: 1024 * 1024,
    });
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      stopping = true;
      void invoke("stop").finally(() => process.exit(0));
    });
  try {
    await invoke("connect");
    while (!stopping) {
      const status = JSON.parse((await invoke("status")).stdout);
      if (!status.process_running || !status.healthy || !status.ready)
        throw Error("Tunnel not ready");
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  } catch {
    console.error(
      "Tunnel unavailable; verify the local tunnel configuration and runtime key.",
    );
    await invoke("stop").catch(() => {});
    process.exitCode = 1;
  }
}
