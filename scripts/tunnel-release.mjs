const response = await fetch(
  "https://api.github.com/repos/openai/tunnel-client/releases/latest",
  { headers: { "User-Agent": "codexbridge" } },
);
if (!response.ok) throw Error("GitHub release HTTP " + response.status);
const release = await response.json();
console.log(
  JSON.stringify(
    {
      tag: release.tag_name,
      assets: release.assets
        .filter((a) => /windows|checksum/i.test(a.name))
        .map((a) => ({
          name: a.name,
          url: a.browser_download_url,
          digest: a.digest,
        })),
    },
    null,
    2,
  ),
);
