import { createHash } from "node:crypto";

// Select only a published runtime archive, never an inferred download URL.
export async function downloadLinuxAsset(release, arch, fetchAsset = fetch) {
  const prefix = `tunnel-client-runtime-cloudflared-${release.tag_name}-linux-${arch}`;
  const candidates = release.assets.filter(
    (asset) =>
      asset.name.startsWith(prefix) &&
      [".tar.gz", ".tgz", ".tar.xz", ".zip"].includes(
        asset.name.slice(prefix.length),
      ),
  );
  const manifest = release.assets.find(
    (asset) => asset.name === "SHA256SUMS.txt",
  );
  if (!manifest) throw Error("Missing official SHA256SUMS.txt");
  const response = await fetchAsset(manifest.browser_download_url);
  if (!response.ok) throw Error("Checksum manifest HTTP " + response.status);
  const entries = (await response.text()).split(/\r?\n/).flatMap((line) => {
    const match = /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(line);
    return match ? [{ hash: match[1].toLowerCase(), name: match[2] }] : [];
  });
  const covered = candidates.filter((asset) =>
    entries.some((entry) => entry.name === asset.name),
  );
  if (covered.length !== 1)
    throw Error("Expected one checksum-verified release asset for " + prefix);
  const asset = covered[0];
  const checksums = entries.filter((entry) => entry.name === asset.name);
  if (checksums.length !== 1) throw Error("Ambiguous tunnel client checksum");
  const download = await fetchAsset(asset.browser_download_url);
  if (!download.ok) throw Error("Download HTTP " + download.status);
  const data = Buffer.from(await download.arrayBuffer());
  const digest = "sha256:" + checksums[0].hash;
  if ("sha256:" + createHash("sha256").update(data).digest("hex") !== digest)
    throw Error("Tunnel client checksum mismatch");
  return { name: asset.name, digest, data };
}
