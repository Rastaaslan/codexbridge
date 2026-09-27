import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { downloadLinuxAsset } from "../scripts/tunnel-asset.mjs";

// Offline fixture for the official v0.0.15 naming contract supplied in CB-42.
const name = "tunnel-client-runtime-cloudflared-v0.0.15-linux-amd64.tar.gz";
const data = Buffer.from("fixture archive bytes");
const hash = createHash("sha256").update(data).digest("hex");
const asset = (name: string) => ({
  name,
  browser_download_url: `https://github.com/openai/tunnel-client/releases/download/v0.0.15/${name}`,
});
const release = {
  tag_name: "v0.0.15",
  assets: [
    asset(name),
    asset(name.replace("amd64", "arm64")),
    asset("tunnel-client-v0.0.15-linux-amd64.tar.gz"),
    asset("SHA256SUMS.txt"),
    asset("PUBLIC_URLS.txt"),
  ],
};
function mockFetch(manifest = `${hash}  ${name}\n`, bytes = data) {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url);
      if (url.endsWith("/SHA256SUMS.txt")) return new Response(manifest);
      assert.equal(url, asset(name).browser_download_url);
      return new Response(bytes);
    },
  };
}

test("Linux v0.0.15 selects the published runtime name and verifies official manifest", async () => {
  for (const separator of ["  ", " *"]) {
    const mock = mockFetch(`${hash}${separator}${name}\r\n`);
    const result = await downloadLinuxAsset(release, "amd64", mock.fetch);
    assert.equal(result.name, name);
    assert.equal(result.digest, `sha256:${hash}`);
    assert.deepEqual(result.data, data);
    assert.deepEqual(mock.calls, [
      asset("SHA256SUMS.txt").browser_download_url,
      asset(name).browser_download_url,
    ]);
  }
});

test("Linux fails closed for missing, invalid or duplicate manifest checksums", async () => {
  for (const manifest of [
    "",
    `invalid  ${name}`,
    `${hash}  other.tar.gz`,
    `${hash}  ${name}\n${hash}  ${name}`,
  ]) {
    const mock = mockFetch(manifest);
    await assert.rejects(downloadLinuxAsset(release, "amd64", mock.fetch));
    assert.equal(mock.calls.length, 1);
  }
  await assert.rejects(
    downloadLinuxAsset(
      { ...release, assets: [asset(name)] },
      "amd64",
      mockFetch().fetch,
    ),
    /Missing official/,
  );
});

test("Linux rejects altered archive bytes and failed downloads", async () => {
  await assert.rejects(
    downloadLinuxAsset(
      release,
      "amd64",
      mockFetch(undefined, Buffer.from("tampered")).fetch,
    ),
    /checksum mismatch/,
  );
  await assert.rejects(
    downloadLinuxAsset(
      release,
      "amd64",
      async () => new Response("", { status: 404 }),
    ),
    /manifest HTTP 404/,
  );
  await assert.rejects(
    downloadLinuxAsset(release, "amd64", async (url: string) =>
      url.endsWith("SHA256SUMS.txt")
        ? new Response(`${hash}  ${name}`)
        : new Response("", { status: 503 }),
    ),
    /Download HTTP 503/,
  );
});

test("installer verifies Linux before writing or extracting and retains Windows digest verification", async () => {
  const source = await readFile("scripts/install-tunnel.mjs", "utf8");
  assert.ok(
    source.indexOf("await downloadLinuxAsset(release, arch)") <
      source.indexOf("await mkdir(root"),
  );
  assert.ok(
    source.indexOf("await mkdir(root") < source.indexOf('execFileSync("tar"'),
  );
  assert.match(source, /platform === "windows" \? "zip" : "tar.gz"/);
  assert.match(source, /asset\?\.digest\?\.startsWith\("sha256:"\)/);
  assert.match(
    source,
    /createHash\("sha256"\)\.update\(data\)\.digest\("hex"\) !==\s+asset.digest/,
  );
});
