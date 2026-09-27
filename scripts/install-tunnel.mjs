import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
const response = await fetch(
  "https://api.github.com/repos/openai/tunnel-client/releases/latest",
  { headers: { "User-Agent": "codexbridge" } },
);
if (!response.ok) throw Error("GitHub release HTTP " + response.status);
const release = await response.json();
const platform =
  process.platform === "win32"
    ? "windows"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";
const arch = process.arch === "arm64" ? "arm64" : "amd64";
const name = `tunnel-client-${release.tag_name}-${platform}-${arch}.${platform === "windows" ? "zip" : "tar.gz"}`;
const asset = release.assets.find((a) => a.name === name);
if (!asset?.digest?.startsWith("sha256:"))
  throw Error("No checksum-verified release asset for " + name);
const download = await fetch(asset.browser_download_url);
if (!download.ok) throw Error("Download HTTP " + download.status);
const data = Buffer.from(await download.arrayBuffer());
if (
  "sha256:" + createHash("sha256").update(data).digest("hex") !==
  asset.digest
)
  throw Error("Tunnel client checksum mismatch");
const root = path.resolve(
  process.env.CODEXBRIDGE_HOME || ".codexbridge",
  "bin",
  `tunnel-client-${release.tag_name}`,
);
await mkdir(root, { recursive: true });
const archive = path.join(root, name);
await writeFile(archive, data);
const files = execFileSync("tar", ["-tf", archive], {
  encoding: "utf8",
  windowsHide: true,
})
  .trim()
  .split(/\r?\n/);
if (
  files.some(
    (file) => path.isAbsolute(file) || file.split(/[\\/]/).includes(".."),
  )
)
  throw Error("Unsafe archive path");
execFileSync("tar", ["-xf", archive, "-C", root], { windowsHide: true });
await writeFile(
  path.resolve(
    process.env.CODEXBRIDGE_HOME || ".codexbridge",
    "tunnel-install.json",
  ),
  JSON.stringify(
    { version: release.tag_name, checksum: asset.digest, root, files },
    null,
    2,
  ),
);
console.log("Verified official tunnel-client installed in " + root);
console.log(files.join("\n"));
