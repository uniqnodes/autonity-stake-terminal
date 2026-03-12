import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const OUT_JSON = path.join(ROOT, "src", "data", "validator-registry.json");
const LOGO_DIR = path.join(ROOT, "public", "validator-logos");

const REPO_API =
  "https://api.github.com/repos/stakeflow/network-registry/contents/autonity/validators";
const REF = "main";
const CANDIDATES = ["logo.png", "logo.jpg", "logo.jpeg", "logo.webp", "logo.svg"];
const HEADERS = {
  "User-Agent": "autonity-desk-web-cache-script",
  Accept: "application/vnd.github+json",
};

async function fetchJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }
  return res.json();
}

async function fetchBuffer(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

async function safeUnlinkFilesInDir(dir) {
  try {
    const files = await fs.readdir(dir);
    await Promise.all(files.map((file) => fs.unlink(path.join(dir, file))));
  } catch {
    // no-op
  }
}

async function main() {
  await fs.mkdir(path.dirname(OUT_JSON), { recursive: true });
  await fs.mkdir(LOGO_DIR, { recursive: true });
  await safeUnlinkFilesInDir(LOGO_DIR);

  const rootUrl = `${REPO_API}?ref=${REF}`;
  const dirs = await fetchJson(rootUrl);

  const validators = {};
  let processed = 0;

  for (const entry of dirs) {
    if (!entry || entry.type !== "dir" || !entry.name) continue;

    const address = String(entry.name);
    const lower = address.toLowerCase();
    const meta = {
      moniker: null,
      logoPath: null,
    };

    try {
      const folderItems = await fetchJson(
        `${REPO_API}/${encodeURIComponent(address)}?ref=${REF}`
      );

      const details = folderItems.find((item) => item.name === "validator-details.json");
      if (details?.download_url) {
        try {
          const detailsJson = await fetchJson(details.download_url);
          if (typeof detailsJson?.moniker === "string" && detailsJson.moniker.trim()) {
            meta.moniker = detailsJson.moniker.trim();
          }
        } catch {
          // keep null
        }
      }

      const logoItem = CANDIDATES.map((name) =>
        folderItems.find((item) => item.name === name && item.download_url)
      ).find(Boolean);

      if (logoItem?.download_url) {
        const ext = path.extname(String(logoItem.name)).toLowerCase() || ".png";
        const targetFile = `${lower}${ext}`;
        const targetPath = path.join(LOGO_DIR, targetFile);
        try {
          const logoBuf = await fetchBuffer(logoItem.download_url);
          await fs.writeFile(targetPath, logoBuf);
          meta.logoPath = `/validator-logos/${targetFile}`;
        } catch {
          // keep null
        }
      }

      validators[lower] = meta;
      processed += 1;
      console.log(`cached ${address}`);
    } catch (error) {
      console.warn(`skip ${address}: ${error.message}`);
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: "stakeflow/network-registry",
    count: processed,
    validators,
  };

  await fs.writeFile(OUT_JSON, JSON.stringify(payload, null, 2), "utf8");
  console.log(`written ${OUT_JSON}`);
  console.log(`validators cached: ${processed}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
