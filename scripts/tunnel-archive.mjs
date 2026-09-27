import { execFileSync } from "node:child_process";
import path from "node:path";

export function extractTunnelArchive(
  archive,
  root,
  platform,
  run = execFileSync,
) {
  // Windows ships libarchive tar, which supports ZIP. Debian's GNU tar does not.
  const zip = archive.endsWith(".zip") && platform !== "windows";
  if (!archive.endsWith(".zip") && !/\.(tar\.gz|tgz|tar\.xz)$/.test(archive))
    throw Error("Unsupported tunnel archive format");
  const command = zip ? "unzip" : "tar";
  let listing;
  try {
    listing = run(command, zip ? ["-Z1", archive] : ["-tf", archive], {
      encoding: "utf8",
      windowsHide: true,
    });
  } catch (error) {
    if (zip && error.code === "ENOENT")
      throw Error(
        "ZIP tunnel installation requires unzip (Debian: apt install unzip)",
        { cause: error },
      );
    throw error;
  }
  const files = listing.replace(/\r?\n$/, "").split(/\r?\n/);
  if (
    files.some(
      (file) =>
        !file ||
        /[\x00-\x1f\x7f]/.test(file) ||
        path.posix.isAbsolute(file) ||
        path.win32.isAbsolute(file) ||
        /^[A-Za-z]:/.test(file) ||
        file.split(/[\\/]/).includes(".."),
    )
  )
    throw Error("Unsafe archive path");
  // Test the complete ZIP before extraction; any tool failure aborts installation.
  if (zip) run("unzip", ["-tq", archive], { windowsHide: true });
  run(
    command,
    zip ? ["-oq", archive, "-d", root] : ["-xf", archive, "-C", root],
    { windowsHide: true },
  );
  return files;
}
