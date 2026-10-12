import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import type { GitWorkspace } from "./git.js";
import type { SentinelHost } from "./sentinel-dispatch.js";
import { hash } from "./sentinel-dev.js";
import { signedFileSentinelHost } from "./sentinel-trust.js";

const MIN_AVAILABLE_KIB = 3 * 1024 * 1024;

export function pressureAllows(cpu: string, io: string, memory: string) {
  const metric = (input: string, category: string) => {
    const line = input.split("\n").find((row) => row.startsWith(category + " "));
    const found = line && /avg10=([0-9]+(?:\.[0-9]+)?)/.exec(line);
    if (!found) return null;
    const number = Number(found[1]);
    return Number.isFinite(number) ? number : null;
  };
  const available = /^MemAvailable:\s+(\d+)\s+kB/m.exec(memory);
  const cpuWait = metric(cpu, "some");
  const diskBlocked = metric(io, "full");
  return (
    cpuWait !== null &&
    diskBlocked !== null &&
    available !== null &&
    cpuWait < 10 &&
    diskBlocked < 8 &&
    Number(available[1]) >= MIN_AVAILABLE_KIB
  );
}

export function linuxPressureAllows() {
  try {
    return pressureAllows(
      readFileSync("/proc/pressure/cpu", "utf8"),
      readFileSync("/proc/pressure/io", "utf8"),
      readFileSync("/proc/meminfo", "utf8"),
    );
  } catch {
    return false; // Missing or malformed telemetry cannot authorize execution.
  }
}

export function operatorSentinelHost(
  config: Config,
  git: Pick<GitWorkspace, "repository" | "resolve">,
  canAdmit: (repository: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
  resourcesAllow: () => boolean = linuxPressureAllows,
): SentinelHost | undefined {
  // No filesystem, Git, CPU or credential IO in the default-off case.
  if (
    process.platform !== "linux" ||
    !config.sentinelExecutionEnabled ||
    !config.sentinelEnabled ||
    !config.sentinelDevPolicy?.enabled ||
    config.maxRuntimeRetries !== 0 ||
    env.CODEXBRIDGE_SENTINEL_OPERATOR_OPT_IN !== "1"
  )
    return undefined;
  try {
    const bundlePath = env.CODEXBRIDGE_SENTINEL_GRANTS_FILE;
    const keyPath = env.CODEXBRIDGE_SENTINEL_PUBLIC_KEY_FILE;
    const pinnedKeyHash = env.CODEXBRIDGE_SENTINEL_PUBLIC_KEY_SHA256;
    const list = env.CODEXBRIDGE_SENTINEL_REPOSITORIES_JSON;
    if (
      !bundlePath ||
      !keyPath ||
      !path.isAbsolute(bundlePath) ||
      !path.isAbsolute(keyPath) ||
      !pinnedKeyHash ||
      !/^[a-f0-9]{64}$/.test(pinnedKeyHash) ||
      !list
    )
      return undefined;
    const parsed: unknown = JSON.parse(list);
    if (
      !Array.isArray(parsed) ||
      parsed.length < 1 ||
      parsed.length > 10 ||
      parsed.some((item) => typeof item !== "string" || !path.isAbsolute(item)) ||
      new Set(parsed).size !== parsed.length ||
      !parsed.includes(config.sentinelDevPolicy.repository)
    )
      return undefined;
    const roots = [config.dataDir, ...parsed];
    const protectedPaths = [bundlePath, keyPath];
    for (const file of protectedPaths) {
      // Never use a trust file inside a worker-controlled repository or DB dir.
      for (const root of roots) {
        const relative = path.relative(path.resolve(root), path.resolve(file));
        if (
          relative === "" ||
          (relative !== ".." &&
            !relative.startsWith(".." + path.sep) &&
            !path.isAbsolute(relative))
        )
          return undefined;
      }
    }
    if (lstatSync(keyPath).isSymbolicLink()) return undefined;
    const fd = openSync(keyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let publicKeyPem: string;
    try {
      const stat = fstatSync(fd);
      const location = lstatSync(keyPath);
      if (
        location.isSymbolicLink() ||
        !stat.isFile() ||
        stat.dev !== location.dev ||
        stat.ino !== location.ino ||
        stat.size < 1 ||
        stat.size > 4096
      )
        return undefined;
      publicKeyPem = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    if (hash(publicKeyPem) !== pinnedKeyHash) return undefined;
    return signedFileSentinelHost({
      bundlePath,
      publicKeyPem,
      git,
      repositories: parsed,
      schedulerAllows: (repository) =>
        resourcesAllow() && canAdmit(repository),
    });
  } catch {
    return undefined; // Bad operator file or config => no execution service.
  }
}
