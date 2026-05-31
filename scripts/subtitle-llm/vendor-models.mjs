#!/usr/bin/env node
// Vendors the AI-subtitle models into apps/web/public/models/ so the browser
// loads them same-origin instead of reaching huggingface.co at runtime.
// Downloads via a mirror (HF_ENDPOINT, default hf-mirror.com) because
// huggingface.co is unreachable on the target network. *.onnx files are
// committed through Git LFS (see .gitattributes).
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const HF_ENDPOINT = (process.env.HF_ENDPOINT ?? "https://hf-mirror.com").replace(/\/+$/, "");
const REVISION = "main";
const OUTPUT_ROOT = "apps/web/public/models";

// Only the files transformers.js actually loads for each pipeline.
// Whisper is Seq2Seq -> encoder_model + decoder_model_merged (session_config.js).
// dtype q8 -> "_quantized" suffix (dtypes.js). We deliberately skip unused
// onnx variants (decoder_with_past_*, standalone decoder_model_*, fp16/q4/...).
const MODELS = [
  {
    repo: "onnx-community/whisper-tiny",
    files: [
      "config.json",
      "generation_config.json",
      "preprocessor_config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
      "vocab.json",
      "merges.txt",
      "added_tokens.json",
      "normalizer.json",
      "onnx/encoder_model_quantized.onnx",
      "onnx/decoder_model_merged_quantized.onnx",
    ],
  },
  {
    repo: "ceilf6/code-tape-subtitle-postprocessor-onnx",
    files: [
      "config.json",
      "generation_config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
      "vocab.json",
      "merges.txt",
      "chat_template.jinja",
      "onnx/model_quantized.onnx",
    ],
  },
];

async function main() {
  console.log(`Vendoring subtitle models from ${HF_ENDPOINT} into ${OUTPUT_ROOT}/`);
  let downloaded = 0;
  let skipped = 0;
  for (const model of MODELS) {
    for (const file of model.files) {
      const destPath = join(OUTPUT_ROOT, model.repo, file);
      const url = `${HF_ENDPOINT}/${model.repo}/resolve/${REVISION}/${file}`;
      if (await isNonEmptyFile(destPath)) {
        console.log(`  skip (exists) ${model.repo}/${file}`);
        skipped += 1;
        continue;
      }
      await downloadTo(url, destPath);
      downloaded += 1;
    }
  }
  console.log(`Done: ${downloaded} downloaded, ${skipped} already present.`);
  console.log("Reminder: *.onnx are Git LFS tracked; commit with git-lfs installed.");
}

async function downloadTo(url, destPath) {
  process.stdout.write(`  fetch ${url} ... `);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, buffer);
  console.log(`${formatBytes(buffer.byteLength)} -> ${destPath}`);
}

async function isNonEmptyFile(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

main().catch((error) => {
  console.error(`\nvendor-models failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
