#!/usr/bin/env node
// Build-time guard: fail loudly if any vendored subtitle model / ORT runtime
// asset is still a Git LFS pointer instead of the real binary. Without this,
// a build on a clone where `git lfs pull` did not run would silently copy
// ~130-byte pointer files into dist/ and ship broken models to production.
import { readdir, stat, open } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve asset roots relative to the repo root (two levels up from this
// script: scripts/subtitle-llm/), so the guard works regardless of the CWD
// the build runs from (root orchestrator or apps/web workspace).
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ASSET_ROOTS = [
  join(REPO_ROOT, "apps/web/public/models"),
  join(REPO_ROOT, "apps/web/public/ort"),
];
const ASSET_EXTENSIONS = [".onnx", ".wasm"];
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";
// Real .onnx (protobuf) and .wasm (\0asm) binaries are far larger than a pointer.
const MIN_BINARY_BYTES = 4096;

async function main() {
  const assets = [];
  for (const root of ASSET_ROOTS) {
    await collectAssets(root, assets);
  }
  if (assets.length === 0) {
    fail([
      "No vendored model/ORT assets found under " + ASSET_ROOTS.join(", ") + ".",
      "Run `npm run subtitle:vendor` before building.",
    ]);
  }

  const problems = [];
  for (const path of assets) {
    const info = await stat(path);
    if (info.size < MIN_BINARY_BYTES) {
      problems.push(`${path} is ${info.size}B (too small to be a real binary)`);
    }
    if (await startsWithPointerPrefix(path)) {
      problems.push(`${path} is a Git LFS pointer, not the real binary`);
    }
  }

  if (problems.length > 0) {
    fail([
      "Vendored subtitle assets are not real binaries:",
      ...problems.map((p) => `  - ${p}`),
      "",
      "On a fresh clone, run `git lfs pull` (or `git lfs fetch --all`) so the",
      "real .onnx/.wasm files replace their pointers before building.",
    ]);
  }
  console.log(`Verified ${assets.length} vendored subtitle assets are real binaries.`);
}

async function collectAssets(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectAssets(path, out);
    } else if (ASSET_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(path);
    }
  }
}

async function startsWithPointerPrefix(path) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(LFS_POINTER_PREFIX.length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8") === LFS_POINTER_PREFIX;
  } finally {
    await handle.close();
  }
}

function fail(lines) {
  console.error(`\nverify-vendored-assets failed:\n${lines.join("\n")}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(`\nverify-vendored-assets failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
