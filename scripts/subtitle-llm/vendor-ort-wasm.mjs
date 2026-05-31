#!/usr/bin/env node
// Vendors the onnxruntime-web WASM runtime into apps/web/public/ort/ so
// transformers.js loads it same-origin instead of from cdn.jsdelivr.net.
// Copies the asyncify variants (default) and the non-asyncify variants (Safari)
// from the installed onnxruntime-web package; versions stay locked to the dep.
import { mkdir, copyFile, stat } from "node:fs/promises";
import { join } from "node:path";

const ORT_DIST = "node_modules/onnxruntime-web/dist";
const OUTPUT_DIR = "apps/web/public/ort";

// transformers.js sets wasmPaths to { mjs, wasm } and Safari swaps to the
// non-asyncify build (backends/onnx.js). Ship both so every browser is covered.
const FILES = [
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
];

async function main() {
  console.log(`Vendoring ONNX runtime from ${ORT_DIST}/ into ${OUTPUT_DIR}/`);
  await mkdir(OUTPUT_DIR, { recursive: true });
  for (const file of FILES) {
    const src = join(ORT_DIST, file);
    const dest = join(OUTPUT_DIR, file);
    const info = await stat(src).catch(() => null);
    if (!info?.isFile()) {
      throw new Error(`missing source ${src} (is onnxruntime-web installed?)`);
    }
    await copyFile(src, dest);
    console.log(`  ${file} (${formatBytes(info.size)}) -> ${dest}`);
  }
  console.log("Done. The .wasm files are Git LFS tracked (see .gitattributes).");
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

main().catch((error) => {
  console.error(`\nvendor-ort-wasm failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
