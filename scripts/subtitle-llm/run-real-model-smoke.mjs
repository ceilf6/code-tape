#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildContextFromSample,
  buildTrackFromSample,
  evaluatePostprocessorFixtures,
} from './evaluate-postprocessor.mjs';
import { parseJsonObject } from './schema.mjs';

const DEFAULT_FIXTURE_PATH = 'scripts/tests/fixtures/subtitle-postprocessor-eval.json';
const DEFAULT_SAMPLE_ID = 'react-state-loop';
const DEFAULT_MODEL = 'ceilf6/code-tape-subtitle-postprocessor-onnx';
const DEFAULT_DEVICE = 'wasm';
const DEFAULT_DTYPE = 'q8';
const SMOKE_NAME = 'subtitle-postprocessor-real-model-smoke';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log([
      'Usage: run-real-model-smoke [--fixture path] [--sample-id id] [--model repo]',
      '',
      'Runs one representative subtitle postprocessor fixture with the real default model.',
      'This is a manual smoke benchmark and is intentionally not part of quality:local.',
    ].join('\n'));
    return;
  }
  const metrics = await runRealModelSmoke(options);
  console.log(JSON.stringify(metrics, null, 2));
  if (!metrics.ok) process.exitCode = 1;
}

export async function runRealModelSmoke(options = {}) {
  const model = options.model ?? process.env.SUBTITLE_REAL_MODEL_SMOKE_MODEL ?? DEFAULT_MODEL;
  const device = options.device ?? DEFAULT_DEVICE;
  const dtype = options.dtype ?? DEFAULT_DTYPE;
  const sampleId = options.sampleId ?? DEFAULT_SAMPLE_ID;
  const fixture = options.fixture ?? await readFixture(options.fixturePath ?? DEFAULT_FIXTURE_PATH);
  const sample = selectRepresentativeSample(fixture, sampleId);
  const createPostProcessor = options.createPostProcessor ?? createDefaultPostProcessor;
  const startedAt = performance.now();
  let pipelineReadyDurationMs = 0;
  let generationDurationMs = 0;
  let postProcessor;

  try {
    const readyStartedAt = performance.now();
    postProcessor = await createPostProcessor({ model, device, dtype });
    await postProcessor.warmUp?.();
    pipelineReadyDurationMs = round(performance.now() - readyStartedAt);

    const generationStartedAt = performance.now();
    const result = await postProcessor.process({
      track: buildTrackFromSample(sample),
      context: buildContextFromSample(sample),
    });
    generationDurationMs = round(performance.now() - generationStartedAt);

    const evaluation = await evaluatePostprocessorFixtures(
      { samples: [sample] },
      {
        runRepresentativeSample: async () => JSON.stringify(result),
      },
    );
    const errorType = classifyRealModelSmokeIssues(evaluation.failures);
    const ok = errorType === null;
    return {
      ok,
      smokeName: SMOKE_NAME,
      outputSource: 'real-model-postprocessor',
      model,
      device,
      dtype,
      sampleId: sample.id,
      pipelineReadyDurationMs,
      generationDurationMs,
      totalDurationMs: round(performance.now() - startedAt),
      jsonValid: evaluation.representativeJsonValidRate === 1,
      segmentReferenceValid: evaluation.representativeSegmentReferenceValidRate === 1,
      chapterTimelineValid: evaluation.representativeChapterTimelineValidRate === 1,
      representativePassRate: evaluation.representativePassRate,
      representativeCorrectionHitRate: evaluation.representativeCorrectionHitRate,
      representativeTermHitRate: evaluation.representativeTermHitRate,
      representativeChapterTitleHitRate: evaluation.representativeChapterTitleHitRate,
      errorType,
      failures: evaluation.failures,
    };
  } catch (error) {
    return {
      ok: false,
      smokeName: SMOKE_NAME,
      outputSource: 'real-model-postprocessor',
      model,
      device,
      dtype,
      sampleId,
      pipelineReadyDurationMs,
      generationDurationMs,
      totalDurationMs: round(performance.now() - startedAt),
      jsonValid: false,
      segmentReferenceValid: false,
      chapterTimelineValid: false,
      representativePassRate: 0,
      representativeCorrectionHitRate: 0,
      representativeTermHitRate: 0,
      representativeChapterTitleHitRate: 0,
      errorType: classifyRealModelSmokeError(error),
      errorMessage: error instanceof Error ? error.message : String(error),
      failures: [],
    };
  } finally {
    await postProcessor?.dispose?.();
  }
}

export function selectRepresentativeSample(fixture, sampleId = DEFAULT_SAMPLE_ID) {
  if (!fixture || !Array.isArray(fixture.samples)) {
    throw new Error('real model smoke fixture must contain samples');
  }
  const sample = fixture.samples.find(
    (candidate) => candidate.kind === 'representative' && candidate.id === sampleId,
  );
  if (!sample) {
    throw new Error(`representative smoke sample not found: ${sampleId}`);
  }
  return sample;
}

export function classifyRealModelSmokeIssues(failures = []) {
  const issues = failures.flatMap((failure) => {
    if (typeof failure === 'string') return [failure];
    if (Array.isArray(failure?.issues)) return failure.issues;
    return [];
  });
  if (issues.length === 0) return null;
  if (issues.includes('invalid-json')) return 'invalid-json';
  if (
    issues.includes('unknown-segment') ||
    issues.includes('duplicate-segment') ||
    issues.includes('invalid-segment') ||
    issues.includes('missing-segments')
  ) {
    return 'invalid-segment-reference';
  }
  if (issues.includes('invalid-chapter-timeline') || issues.includes('missing-chapters')) {
    return 'invalid-chapter-timeline';
  }
  return 'contract-validation-error';
}

export function classifyRealModelSmokeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /当前浏览器无法加载本地字幕 LLM 模型|Could not locate file|Could not load model|Not Found|Failed to fetch|Load failed|NetworkError|MatMulNBits|Missing required scale/iu.test(
      message,
    )
  ) {
    return 'model-load-error';
  }
  if (/LLM 输出|JSON/iu.test(message)) return 'invalid-json';
  if (/segment|subtitle/i.test(message)) return 'invalid-segment-reference';
  if (/chapter|timeline/i.test(message)) return 'invalid-chapter-timeline';
  return 'generation-error';
}

async function readFixture(path) {
  return parseJsonObject(await readFile(path, 'utf8'), path);
}

async function createDefaultPostProcessor({ model }) {
  const { createServer } = await import('vite');
  const webRoot = resolve(process.cwd(), 'apps/web');
  const server = await createServer({
    root: webRoot,
    configFile: resolve(webRoot, 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  });
  const module = await server.ssrLoadModule('/src/features/subtitles/subtitlePostProcessor.ts');
  const postProcessor = module.createHuggingFaceSubtitlePostProcessor({ model });
  return {
    async warmUp() {
      await postProcessor.warmUp?.();
    },
    async process(input) {
      return postProcessor.process(input);
    },
    async dispose() {
      postProcessor.dispose?.();
      await server.close();
    },
  };
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--fixture') options.fixturePath = readArgValue(args, index += 1, arg);
    else if (arg === '--sample-id') options.sampleId = readArgValue(args, index += 1, arg);
    else if (arg === '--model') options.model = readArgValue(args, index += 1, arg);
    else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function readArgValue(args, index, name) {
  const value = args[index];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
