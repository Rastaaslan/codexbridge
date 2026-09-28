import path from "node:path";

export function resolveTunnelBinary(installed, platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (
    !installed ||
    typeof installed.root !== "string" ||
    !paths.isAbsolute(installed.root) ||
    !Array.isArray(installed.files)
  )
    throw Error("Invalid tunnel installation metadata");
  const names =
    platform === "win32"
      ? ["tunnel-client.exe", "tunnel-client-runtime-cloudflared.exe"]
      : ["tunnel-client", "tunnel-client-runtime", "tunnel-client-runtime-cloudflared"];
  const candidates = [];
  for (const file of installed.files) {
    if (
      typeof file !== "string" ||
      !file ||
      /[\x00-\x1f\x7f]/.test(file) ||
      path.posix.isAbsolute(file) ||
      path.win32.isAbsolute(file) ||
      /^[A-Za-z]:/.test(file) ||
      file.split(/[\\/]/).includes("..")
    )
      throw Error("Unsafe tunnel installation path");
    // ZIP listings use forward slashes; do not reinterpret backslashes on Unix.
    if (platform !== "win32" && file.includes("\\"))
      throw Error("Unsafe tunnel installation path");
    if (!file.endsWith("/") && names.includes(paths.basename(file)))
      candidates.push(paths.resolve(installed.root, file));
  }
  if (candidates.length !== 1)
    throw Error(
      "Expected exactly one tunnel executable in installation metadata",
    );
  return candidates[0];
}

export function tunnelMcpCommand({
  platform = process.platform,
  managed = process.env.CODEXBRIDGE_MANAGED,
  cwd = process.cwd(),
  execPath = process.execPath,
} = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const managedLinux = platform === "linux" && managed === "1";
  const cli = managedLinux
    ? "/opt/codexbridge/current/dist/cli.js"
    : paths.resolve(cwd, "dist/cli.js");
  const node = managedLinux ? "/usr/bin/node" : execPath;
  return `"${node.replaceAll("\\", "/")}" "${cli.replaceAll("\\", "/")}" mcp-stdio`;
}
