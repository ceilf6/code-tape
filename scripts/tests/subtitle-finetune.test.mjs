import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildTrainingRecord,
  buildDistillationMessages,
  readPromptSegments,
  validateSubtitleDistillationExample,
  validateSubtitleTrainingRecord,
  validateSubtitleTeacherResult,
} from '../subtitle-llm/schema.mjs';

const seedExample = {
  id: 'react-state-hook-001',
  language: 'zh-CN',
  context: {
    fileName: 'Counter.tsx',
    code: 'const [count, setCount] = useState(0);',
    runtimeOutput: 'ReferenceError: count is not defined',
    glossary: ['React', 'useState', 'setCount', 'code-tape'],
  },
  segments: [
    { id: 'subtitle-1', startMs: 0, endMs: 1200, text: '这里用 use state 维护 count' },
    { id: 'subtitle-2', startMs: 1200, endMs: 2600, text: '然后 set count 触发 render' },
  ],
};

const teacherResult = {
  segments: [
    { id: 'subtitle-1', text: '这里用 useState 维护 count' },
    { id: 'subtitle-2', text: '然后 setCount 触发 render' },
  ],
  chapters: [{ title: '状态设计', startMs: 0, endMs: 2600 }],
};

test('validates subtitle distillation examples for correction and chapter generation', () => {
  assert.deepEqual(validateSubtitleDistillationExample(seedExample), seedExample);
  assert.deepEqual(validateSubtitleTeacherResult(teacherResult, seedExample), teacherResult);
});

test('accepts sparse teacher subtitle corrections for unchanged segments', () => {
  assert.deepEqual(
    validateSubtitleTeacherResult(
      {
        segments: [{ id: 'subtitle-2', text: '然后 setCount 触发 render' }],
        chapters: teacherResult.chapters,
      },
      seedExample,
    ),
    {
      segments: [{ id: 'subtitle-2', text: '然后 setCount 触发 render' }],
      chapters: teacherResult.chapters,
    },
  );
});

test('rejects distillation samples that omit chapters', () => {
  assert.throws(
    () => validateSubtitleTeacherResult({ segments: teacherResult.segments }, seedExample),
    /chapters/,
  );
});

test('rejects distillation samples without chapter training signal', () => {
  assert.throws(
    () =>
      validateSubtitleTeacherResult(
        {
          segments: teacherResult.segments,
          chapters: [],
        },
        seedExample,
      ),
    /chapters must contain at least one chapter/,
  );
});

test('rejects duplicate input subtitle segment ids before distillation', () => {
  assert.throws(
    () =>
      validateSubtitleDistillationExample({
        ...seedExample,
        segments: [
          seedExample.segments[0],
          {
            ...seedExample.segments[1],
            id: seedExample.segments[0].id,
          },
        ],
      }),
    /duplicate segment id/,
  );
});

test('rejects overlapping or unsorted input subtitle segments before distillation', () => {
  assert.throws(
    () =>
      validateSubtitleDistillationExample({
        ...seedExample,
        segments: [
          seedExample.segments[0],
          {
            ...seedExample.segments[1],
            startMs: 1000,
            endMs: 2000,
          },
        ],
      }),
    /segments must be ordered and non-overlapping/,
  );
});

test('rejects malformed assistant training JSON contracts', () => {
  const record = buildTrainingRecord({
    example: seedExample,
    teacherResult,
    teacherModel: 'gpt-5.5',
  });

  assert.throws(
    () =>
      validateSubtitleTrainingRecord({
        ...record,
        messages: [
          record.messages[0],
          record.messages[1],
          {
            role: 'assistant',
            content: JSON.stringify({ segments: 'bad shape', chapters: [] }),
          },
        ],
      }),
    /teacher result segments are required/,
  );
});

test('rejects generated chapters outside the source subtitle timeline', () => {
  assert.throws(
    () =>
      validateSubtitleTeacherResult(
        {
          segments: teacherResult.segments,
          chapters: [{ title: '越界章节', startMs: 2600, endMs: 3200 }],
        },
        seedExample,
      ),
    /chapters must stay within the source subtitle timeline/,
  );
});

test('rejects overlapping or unsorted generated chapters', () => {
  assert.throws(
    () =>
      validateSubtitleTeacherResult(
        {
          segments: teacherResult.segments,
          chapters: [
            { title: '实现', startMs: 1000, endMs: 2200 },
            { title: '分析', startMs: 1500, endMs: 2600 },
          ],
        },
        seedExample,
      ),
    /chapters must be ordered and non-overlapping/,
  );
});

test('rejects unknown or duplicate subtitle segment ids in teacher output', () => {
  assert.throws(
    () =>
      validateSubtitleTeacherResult(
        {
          segments: [{ id: 'subtitle-404', text: 'bad segment' }],
          chapters: teacherResult.chapters,
        },
        seedExample,
      ),
    /unknown segment/,
  );
  assert.throws(
    () =>
      validateSubtitleTeacherResult(
        {
          segments: [
            { id: 'subtitle-1', text: 'first correction' },
            { id: 'subtitle-1', text: 'second correction' },
          ],
          chapters: teacherResult.chapters,
        },
        seedExample,
      ),
    /repeats segment/,
  );
});

test('rejects secrets in distillation inputs and outputs', () => {
  const fakeHfToken = `${'h'}${'f'}_${'a'.repeat(30)}`;
  const fakeApiKey = `${'s'}${'k'}-${'b'.repeat(30)}`;
  assert.throws(
    () =>
      validateSubtitleDistillationExample({
        ...seedExample,
        context: {
          ...seedExample.context,
          runtimeOutput: `never store ${fakeHfToken} in fixtures`,
        },
      }),
    /secret-like value/,
  );
  assert.throws(
    () =>
      validateSubtitleTeacherResult(
        {
          segments: [{ id: 'subtitle-1', text: `contains ${fakeApiKey}` }],
          chapters: [],
        },
        { ...seedExample, segments: [seedExample.segments[0]] },
      ),
    /secret-like value/,
  );
});

test('builds deterministic teacher distillation messages without secrets', () => {
  const messages = buildDistillationMessages(seedExample);
  const userPayload = JSON.parse(messages[1].content);

  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /只输出 JSON/);
  assert.match(messages[0].content, /Goal: correct ASR subtitle text/u);
  assert.match(messages[0].content, /Input subtitle rows with timing are in inputSegments/u);
  assert.doesNotMatch(messages[0].content, /corrected text/u);
  assert.match(messages[1].content, /Counter\.tsx/);
  assert.match(messages[1].content, /subtitle-1/);
  assert.match(messages[1].content, /"inputSegments"/u);
  assert.doesNotMatch(messages[1].content, /"timeline"/u);
  assert.doesNotMatch(messages[1].content, /"segments"/u);
  assert.doesNotMatch(messages[1].content, /"language"/u);
  assert.deepEqual(userPayload.inputSegments, seedExample.segments);
  assert.equal(messages[1].content.match(/subtitle-1/gu).length, 1);
  assert.doesNotMatch(JSON.stringify(messages), new RegExp(`${'h'}${'f'}_|${'s'}${'k'}-`, 'u'));
});

test('subtitle scripts reuse the canonical prompt segment reader', () => {
  const payload = {
    inputSegments: [{ id: 'subtitle-1', startMs: 0, endMs: 1200, text: '继续讲 use state' }],
  };
  const legacyPayload = {
    inputSegments: [{ id: 'subtitle-2', text: '然后 set count 触发 render' }],
    timeline: [{ id: 'subtitle-2', startMs: 1200, endMs: 2600 }],
  };

  assert.deepEqual(readPromptSegments(payload), [
    { id: 'subtitle-1', text: '继续讲 use state', startMs: 0, endMs: 1200 },
  ]);
  assert.deepEqual(readPromptSegments(legacyPayload), [
    { id: 'subtitle-2', text: '然后 set count 触发 render', startMs: 1200, endMs: 2600 },
  ]);

  for (const path of [
    'scripts/subtitle-llm/evaluate-corpus.mjs',
    'scripts/subtitle-llm/augment-corpus.mjs',
  ]) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /function readPromptSegments/u);
    assert.match(source, /readPromptSegments/u);
  }
});

test('curated subtitle stability topics live outside the augmentation script', () => {
  const dataPath = 'ml/subtitle-postprocessor/data/stability-topics.json';
  const scriptSource = readFileSync('scripts/subtitle-llm/augment-corpus.mjs', 'utf8');
  const data = JSON.parse(readFileSync(dataPath, 'utf8'));

  assert.ok(Array.isArray(data.stabilityTopics));
  assert.ok(Array.isArray(data.correctionTopics));
  assert.ok(data.stabilityTopics.length >= 10);
  assert.ok(data.correctionTopics.length >= 10);
  assert.doesNotMatch(scriptSource, /const STABILITY_TOPICS = \[/u);
  assert.doesNotMatch(scriptSource, /const CORRECTION_TOPICS = \[/u);
  assert.doesNotMatch(scriptSource, /index\s*%\s*10/u);
  assert.match(scriptSource, /stabilityTopics\.length/u);
});

test('subtitle fine-tuning corpora have enough domain coverage for stable local LLM output', () => {
  const seedExamples = readJsonl('ml/subtitle-postprocessor/data/seed_examples.jsonl');
  const distilledRecords = readJsonl('ml/subtitle-postprocessor/data/generated/distilled.jsonl');
  const corpusText = JSON.stringify([...seedExamples, ...distilledRecords]);

  assert.ok(seedExamples.length >= 200, `expected at least 200 seed examples, got ${seedExamples.length}`);
  assert.ok(
    distilledRecords.length >= 200,
    `expected at least 200 distilled training records, got ${distilledRecords.length}`,
  );
  for (const term of [
    'React',
    'TypeScript',
    'Vite',
    'Playwright',
    'Vitest',
    'Web Worker',
    'WebGPU',
    'IndexedDB',
    'repo-guard',
    'SubtitlePanel',
    'chapters',
  ]) {
    assert.match(corpusText, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
});

test('checked-in distilled corpus uses the runtime compact inputSegments prompt shape', () => {
  const distilledRecords = readJsonl('ml/subtitle-postprocessor/data/generated/distilled.jsonl');

  for (const [index, record] of distilledRecords.entries()) {
    const [system, user] = record.messages;
    const userPayload = JSON.parse(user.content);

    assert.match(system.content, /Input subtitle rows with timing are in inputSegments/u);
    assert.ok(Array.isArray(userPayload.inputSegments), `record ${index} inputSegments missing`);
    assert.equal(userPayload.timeline, undefined, `record ${index} should not include timeline`);
    for (const [segmentIndex, segment] of userPayload.inputSegments.entries()) {
      assert.equal(typeof segment.id, 'string', `record ${index} segment ${segmentIndex} id missing`);
      assert.equal(typeof segment.startMs, 'number', `record ${index} segment ${segmentIndex} startMs missing`);
      assert.equal(typeof segment.endMs, 'number', `record ${index} segment ${segmentIndex} endMs missing`);
      assert.equal(typeof segment.text, 'string', `record ${index} segment ${segmentIndex} text missing`);
    }
  }
});

test('subtitle fine-tuning corpus teaches sparse long-track outputs instead of full rewrites', async () => {
  const { evaluateRecords } = await import('../subtitle-llm/evaluate-corpus.mjs');
  const distilledRecords = readJsonl('ml/subtitle-postprocessor/data/generated/distilled.jsonl');
  const metrics = evaluateRecords(distilledRecords);

  assert.ok(metrics.sparseOutputRate >= 0.85, `sparseOutputRate ${metrics.sparseOutputRate}`);
  assert.ok(metrics.fullSegmentOutputRate <= 0.15, `fullSegmentOutputRate ${metrics.fullSegmentOutputRate}`);
  assert.ok(
    metrics.averageOutputSegmentRatio <= 0.3,
    `averageOutputSegmentRatio ${metrics.averageOutputSegmentRatio}`,
  );
  assert.ok(metrics.longTrackRecordRate >= 0.75, `longTrackRecordRate ${metrics.longTrackRecordRate}`);
  assert.equal(metrics.sparseSegmentReferenceRate, 1);
  assert.equal(metrics.chapterSignalRate, 1);
});

test('subtitle postprocessor evaluation baseline covers quality, failure modes, and fixture timing', async () => {
  const { evaluatePostprocessorFixtures } = await import('../subtitle-llm/evaluate-postprocessor.mjs');
  const fixture = JSON.parse(
    readFileSync('scripts/tests/fixtures/subtitle-postprocessor-eval.json', 'utf8'),
  );
  const metrics = await evaluatePostprocessorFixtures(fixture, {
    runRepresentativeSample: async (sample) => sample.mockModelOutput,
  });

  assert.equal(metrics.samples, 7);
  assert.equal(metrics.representativeSamples, 3);
  assert.equal(metrics.negativeSamples, 4);
  assert.equal(metrics.representativeOutputSource, 'postprocessor-runner');
  assert.equal(metrics.representativePassRate, 1);
  assert.equal(metrics.representativeJsonValidRate, 1);
  assert.equal(metrics.representativeSegmentReferenceValidRate, 1);
  assert.equal(metrics.representativeCorrectionHitRate, 1);
  assert.equal(metrics.representativeTermHitRate, 1);
  assert.equal(metrics.representativeChapterTimelineValidRate, 1);
  assert.equal(metrics.representativeChapterTitleHitRate, 1);
  assert.ok(metrics.overallEvaluationDurationMs >= 0);
  assert.ok(metrics.averageFixtureValidationDurationMs >= 0);
  assert.ok(
    metrics.maxFixtureValidationDurationMs >= metrics.averageFixtureValidationDurationMs,
  );
  assert.equal(Object.hasOwn(metrics, 'averageDurationMs'), false);
  assert.equal(Object.hasOwn(metrics, 'maxDurationMs'), false);
  for (const result of metrics.sampleResults) {
    assert.ok(result.fixtureValidationDurationMs >= 0);
    assert.equal(Object.hasOwn(result, 'durationMs'), false);
    if (result.kind === 'representative') {
      assert.equal(result.outputSource, 'postprocessor-runner');
    }
  }
  assert.deepEqual(
    metrics.detectedNegativeIssues.sort(),
    ['duplicate-segment', 'invalid-chapter-timeline', 'invalid-json', 'unknown-segment'].sort(),
  );
});

test('subtitle postprocessor evaluation gets representative outputs from the runner', async () => {
  const { evaluatePostprocessorFixtures } = await import('../subtitle-llm/evaluate-postprocessor.mjs');
  const fixture = JSON.parse(
    readFileSync('scripts/tests/fixtures/subtitle-postprocessor-eval.json', 'utf8'),
  );
  const representativeOutputById = new Map(
    fixture.samples
      .filter((sample) => sample.kind === 'representative')
      .map((sample) => [sample.id, sample.mockModelOutput]),
  );
  for (const sample of fixture.samples) {
    if (sample.kind === 'representative') {
      sample.output = 'this fixture output must be ignored';
    }
  }
  const seenRepresentativeIds = [];

  const metrics = await evaluatePostprocessorFixtures(fixture, {
    runRepresentativeSample: async (sample) => {
      seenRepresentativeIds.push(sample.id);
      return representativeOutputById.get(sample.id);
    },
  });

  assert.equal(metrics.representativePassRate, 1);
  assert.deepEqual(seenRepresentativeIds.sort(), [
    'playwright-regression',
    'react-state-loop',
    'vite-worker-cache',
  ]);
});

test('subtitle postprocessor evaluation CLI uses the current postprocessor runner by default', () => {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/subtitle-llm/evaluate-postprocessor.mjs',
      'scripts/tests/fixtures/subtitle-postprocessor-eval.json',
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const jsonStart = result.stdout.indexOf('{');
  assert.ok(jsonStart >= 0, result.stdout);
  const metrics = JSON.parse(result.stdout.slice(jsonStart));
  assert.equal(metrics.representativeOutputSource, 'postprocessor-runner');
  assert.equal(metrics.representativePassRate, 1);
  assert.equal(metrics.failures.length, 0);
});

test('PR self-check asks for one correction and chapter generation evaluation result', () => {
  const template = readFileSync('.github/PULL_REQUEST_TEMPLATE.md', 'utf8');
  const technicalPlan = readFileSync('docs/技术方案.md', 'utf8');
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

  assert.match(template, /纠错并生成章节/u);
  assert.match(template, /npm run subtitle:postprocess:evaluate/u);
  assert.match(template, /npm run subtitle:postprocess:runtime-benchmark/u);
  assert.match(template, /representativeOutputSource/u);
  assert.match(template, /overallEvaluationDurationMs/u);
  assert.match(template, /输出校验耗时/u);
  assert.match(template, /postprocessClickToResultReadyDurationMs/u);
  assert.match(template, /postProcessTimeoutBudgetMs/u);
  assert.match(template, /playbackProbeResponsiveDuringPostprocess/u);
  assert.equal(
    packageJson.scripts['subtitle:postprocess:runtime-benchmark'],
    'node scripts/subtitle-llm/run-runtime-benchmark.mjs',
  );
  const runtimeBenchmarkRunner = readFileSync(
    'scripts/subtitle-llm/run-runtime-benchmark.mjs',
    'utf8',
  );
  assert.match(runtimeBenchmarkRunner, /SUBTITLE_RUNTIME_BENCHMARK/u);
  assert.match(runtimeBenchmarkRunner, /subtitlePostProcessorRuntimeBenchmark\.test\.tsx/u);
  assert.match(technicalPlan, /npm run subtitle:postprocess:runtime-benchmark/u);
  assert.match(technicalPlan, /postprocessor-runner/u);
  assert.match(technicalPlan, /representativeOutputSource/u);
  assert.match(technicalPlan, /postprocessClickToResultReadyDurationMs/u);
  assert.match(technicalPlan, /postProcessTimeoutBudgetMs/u);
  assert.match(technicalPlan, /workerLoadDurationMs/u);
  assert.match(technicalPlan, /playbackProbeResponsiveDuringPostprocess/u);
});

function readJsonl(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('builds SFT records with an assistant JSON contract', () => {
  const record = buildTrainingRecord({
    example: seedExample,
    teacherResult,
    teacherModel: 'gpt-5.5',
  });

  assert.deepEqual(validateSubtitleTrainingRecord(record), record);
  assert.equal(record.messages[2].role, 'assistant');
  assert.match(record.messages[2].content, /"chapters"/);
  assert.deepEqual(record.metadata.inputSegmentIds, ['subtitle-1', 'subtitle-2']);
});

test('LoRA training parser does not trust remote code unless explicitly requested', () => {
  const python = [
    'import importlib.util',
    'spec = importlib.util.spec_from_file_location("train_lora", "ml/subtitle-postprocessor/train_lora.py")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'parser = module.build_parser()',
    'default_args = parser.parse_args(["--train-jsonl", "train.jsonl"])',
    'opt_in_args = parser.parse_args(["--train-jsonl", "train.jsonl", "--trust-remote-code"])',
    'print(f"{default_args.trust_remote_code},{opt_in_args.trust_remote_code}")',
  ].join('; ');
  const result = spawnSync('python3', ['-c', python], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'False,True');
});

test('LoRA training defaults to the browser-targeted SmolLM2 base model', () => {
  const python = [
    'import importlib.util',
    'spec = importlib.util.spec_from_file_location("train_lora", "ml/subtitle-postprocessor/train_lora.py")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'parser = module.build_parser()',
    'args = parser.parse_args(["--train-jsonl", "train.jsonl"])',
    'print(args.base_model)',
  ].join('; ');
  const result = spawnSync('python3', ['-c', python], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'HuggingFaceTB/SmolLM2-135M-Instruct');
});

test('LoRA training masks loss to assistant JSON tokens', () => {
  const python = [
    'import importlib.util',
    'import json',
    'spec = importlib.util.spec_from_file_location("train_lora", "ml/subtitle-postprocessor/train_lora.py")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'apply=lambda self,messages,add_generation_prompt=False,tokenize=False: "PROMPT" if add_generation_prompt else "PROMPT{}"',
    'call=lambda self,text,add_special_tokens=False,return_offsets_mapping=False: {"input_ids": list(range(len(text))), **({"offset_mapping": [(i, i + 1) for i in range(len(text))]} if return_offsets_mapping else {})}',
    'FakeTokenizer=type("FakeTokenizer", (), {"apply_chat_template": apply, "__call__": call})',
    'record={"messages":[{"role":"system","content":"s"},{"role":"user","content":"u"},{"role":"assistant","content":"{}"}]}',
    'tokens = module.tokenize_training_record(record, FakeTokenizer(), 128)',
    'print(json.dumps(tokens["labels"]))',
  ].join('; ');
  const result = spawnSync('python3', ['-c', python], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [-100, -100, -100, -100, -100, -100, 6, 7]);
});

test('LoRA training masks labels to assistant JSON without chat template tail tokens', () => {
  const python = [
    'import importlib.util',
    'import json',
    'spec = importlib.util.spec_from_file_location("train_lora", "ml/subtitle-postprocessor/train_lora.py")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'PROMPT = "<s>system\\ns</s><u>payload</u><a>"',
    'ASSISTANT = "{\\"segments\\":[],\\"chapters\\":[{\\"title\\":\\"片段 1\\",\\"startMs\\":0}]}"',
    'FULL = PROMPT + ASSISTANT + "</a>"',
    'class BoundaryMergingTokenizer:',
    '    def __init__(self):',
    '        self.id_to_text = {}',
    '    def apply_chat_template(self, messages, add_generation_prompt=False, tokenize=False):',
    '        return PROMPT if add_generation_prompt else FULL',
    '    def __call__(self, text, add_special_tokens=False, return_offsets_mapping=False):',
    '        if text == PROMPT:',
    '            return {"input_ids": list(range(999))}',
    '        ids = []',
    '        offsets = []',
    '        cursor = 0',
    '        for index, chunk_size in enumerate([1] * len(text), start=1):',
    '            start = cursor',
    '            end = min(len(text), cursor + chunk_size)',
    '            if start >= end:',
    '                break',
    '            ids.append(index)',
    '            offsets.append((start, end))',
    '            self.id_to_text[index] = text[start:end]',
    '            cursor = end',
    '        if return_offsets_mapping:',
    '            return {"input_ids": ids, "offset_mapping": offsets}',
    '        return {"input_ids": ids}',
    '    def decode(self, ids):',
    '        return "".join(self.id_to_text[token_id] for token_id in ids)',
    'tokenizer = BoundaryMergingTokenizer()',
    'record={"messages":[{"role":"system","content":"s"},{"role":"user","content":"payload"},{"role":"assistant","content":ASSISTANT}]}',
    'tokens = module.tokenize_training_record(record, tokenizer, 256)',
    'assistant_ids = [token_id for token_id, label in zip(tokens["input_ids"], tokens["labels"]) if label != -100]',
    'print(tokenizer.decode(assistant_ids))',
  ].join('\n');
  const result = spawnSync('python3', ['-c', python], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    '{"segments":[],"chapters":[{"title":"片段 1","startMs":0}]}',
  );
});

test('LoRA training keeps tokens that overlap the assistant JSON start boundary', () => {
  const python = [
    'import importlib.util',
    'import json',
    'spec = importlib.util.spec_from_file_location("train_lora", "ml/subtitle-postprocessor/train_lora.py")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'PROMPT = "<s>system\\ns</s><u>payload</u><a>\\n"',
    'ASSISTANT = "{\\"segments\\":[],\\"chapters\\":[]}"',
    'FULL = PROMPT + ASSISTANT + "</a>"',
    'class CrossBoundaryTokenizer:',
    '    def apply_chat_template(self, messages, add_generation_prompt=False, tokenize=False):',
    '        return PROMPT if add_generation_prompt else FULL',
    '    def __call__(self, text, add_special_tokens=False, return_offsets_mapping=False):',
    '        prompt_end = len(PROMPT)',
    '        offsets = [(0, prompt_end - 1), (prompt_end - 1, prompt_end + 1)]',
    '        cursor = prompt_end + 1',
    '        while cursor < len(text):',
    '            offsets.append((cursor, cursor + 1))',
    '            cursor += 1',
    '        ids = list(range(1, len(offsets) + 1))',
    '        if return_offsets_mapping:',
    '            return {"input_ids": ids, "offset_mapping": offsets}',
    '        return {"input_ids": ids}',
    'tokenizer = CrossBoundaryTokenizer()',
    'record={"messages":[{"role":"system","content":"s"},{"role":"user","content":"payload"},{"role":"assistant","content":ASSISTANT}]}',
    'tokens = module.tokenize_training_record(record, tokenizer, 256)',
    'boundary_index = 1',
    'print(json.dumps({"boundaryId": tokens["input_ids"][boundary_index], "boundaryLabel": tokens["labels"][boundary_index]}))',
  ].join('\n');
  const result = spawnSync('python3', ['-c', python], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { boundaryId: 2, boundaryLabel: 2 });
});

test('LoRA training locates assistant JSON when prompt and full chat templates differ at the boundary', () => {
  const python = [
    'import importlib.util',
    'spec = importlib.util.spec_from_file_location("train_lora", "ml/subtitle-postprocessor/train_lora.py")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'PROMPT = "<s>system\\ns</s><u>payload</u><a>\\n"',
    'FULL_PREFIX = "<s>system\\ns</s><u>payload</u><a>"',
    'ASSISTANT = "{\\"segments\\":[],\\"chapters\\":[]}"',
    'FULL = FULL_PREFIX + ASSISTANT + "</a>"',
    'class BoundaryDriftTokenizer:',
    '    def __init__(self):',
    '        self.id_to_text = {}',
    '    def apply_chat_template(self, messages, add_generation_prompt=False, tokenize=False):',
    '        return PROMPT if add_generation_prompt else FULL',
    '    def __call__(self, text, add_special_tokens=False, return_offsets_mapping=False):',
    '        ids = []',
    '        offsets = []',
    '        for index, char in enumerate(text, start=1):',
    '            ids.append(index)',
    '            offsets.append((index - 1, index))',
    '            self.id_to_text[index] = char',
    '        if return_offsets_mapping:',
    '            return {"input_ids": ids, "offset_mapping": offsets}',
    '        return {"input_ids": ids}',
    '    def decode(self, ids):',
    '        return "".join(self.id_to_text[token_id] for token_id in ids)',
    'tokenizer = BoundaryDriftTokenizer()',
    'record={"messages":[{"role":"system","content":"s"},{"role":"user","content":"payload"},{"role":"assistant","content":ASSISTANT}]}',
    'tokens = module.tokenize_training_record(record, tokenizer, 256)',
    'assistant_ids = [token_id for token_id, label in zip(tokens["input_ids"], tokens["labels"]) if label != -100]',
    'print(tokenizer.decode(assistant_ids))',
  ].join('\n');
  const result = spawnSync('python3', ['-c', python], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '{"segments":[],"chapters":[]}');
});

test('evaluates subtitle SFT records for JSON, chapter, and glossary quality', () => {
  const result = spawnSync(
    'node',
    ['scripts/subtitle-llm/evaluate-corpus.mjs', 'scripts/tests/fixtures/valid-subtitle-train.jsonl'],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const metrics = JSON.parse(result.stdout);
  assert.equal(metrics.records, 1);
  assert.equal(metrics.invalidRecords, 0);
  assert.equal(metrics.jsonValidRate, 1);
  assert.equal(metrics.sparseSegmentReferenceRate, 1);
  assert.equal(metrics.chapterSignalRate, 1);
  assert.equal(metrics.glossaryPreservationRate, 1);
  assert.equal(Object.hasOwn(metrics, 'segmentCoverageRate'), false);
  assert.equal(Object.hasOwn(metrics, 'simplifiedChineseRate'), false);
});

test('imports subtitle corpus evaluator without running the CLI entrypoint', async () => {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const { evaluateRecords } = await import('../subtitle-llm/evaluate-corpus.mjs');

    assert.equal(typeof evaluateRecords, 'function');
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test('subtitle corpus evaluation applies sparse corrections before scoring glossary preservation', async () => {
  const { evaluateRecords } = await import('../subtitle-llm/evaluate-corpus.mjs');
  const record = buildTrainingRecord({
    example: {
      ...seedExample,
      context: {
        ...seedExample.context,
        glossary: ['React', 'useState', 'setCount'],
      },
      segments: [
        { id: 'subtitle-1', startMs: 0, endMs: 1200, text: 'React useState 已经正确' },
        { id: 'subtitle-2', startMs: 1200, endMs: 2600, text: '然后 set count 触发 render' },
      ],
    },
    teacherResult: {
      segments: [{ id: 'subtitle-2', text: '然后 setCount 触发 render' }],
      chapters: [{ title: '状态设计', startMs: 0, endMs: 2600 }],
    },
    teacherModel: 'gpt-5.5',
  });

  const metrics = evaluateRecords([record]);

  assert.equal(metrics.sparseSegmentReferenceRate, 1);
  assert.equal(metrics.sparseOutputRate, 1);
  assert.equal(metrics.fullSegmentOutputRate, 0);
  assert.equal(metrics.averageOutputSegmentRatio, 0.5);
  assert.equal(metrics.glossaryPreservationRate, 1);
});

test('subtitle corpus evaluation exposes full-output and long-track stability risks', async () => {
  const { evaluateRecords } = await import('../subtitle-llm/evaluate-corpus.mjs');
  const fullOutputRecord = buildTrainingRecord({
    example: {
      ...seedExample,
      segments: [
        { id: 'subtitle-1', startMs: 0, endMs: 1000, text: '先看 use state' },
        { id: 'subtitle-2', startMs: 1000, endMs: 2000, text: '然后 render result' },
      ],
    },
    teacherResult: {
      segments: [
        { id: 'subtitle-1', text: '先看 useState' },
        { id: 'subtitle-2', text: '然后 render result' },
      ],
      chapters: [{ title: '状态设计', startMs: 0, endMs: 2000 }],
    },
    teacherModel: 'gpt-5.5',
  });
  const longSparseRecord = buildTrainingRecord({
    example: {
      ...seedExample,
      segments: Array.from({ length: 8 }, (_, index) => ({
        id: `subtitle-${index + 1}`,
        startMs: index * 1000,
        endMs: index * 1000 + 900,
        text: index === 5 ? '最后调用 use effect 清理 worker' : `第 ${index + 1} 段不需要修改`,
      })),
    },
    teacherResult: {
      segments: [{ id: 'subtitle-6', text: '最后调用 useEffect 清理 worker' }],
      chapters: [
        { title: '问题分析', startMs: 0, endMs: 3000 },
        { title: '生命周期清理', startMs: 3000, endMs: 7900 },
      ],
    },
    teacherModel: 'gpt-5.5',
  });

  const metrics = evaluateRecords([fullOutputRecord, longSparseRecord]);

  assert.equal(metrics.fullSegmentOutputRate, 0.5);
  assert.equal(metrics.sparseOutputRate, 0.5);
  assert.equal(metrics.longTrackRecordRate, 0.5);
  assert.equal(metrics.averageOutputSegmentRatio, 0.5625);
  assert.equal(metrics.chapterSignalRate, 1);
});

test('subtitle corpus evaluation does not treat language style as a blocking metric', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'subtitle-language-neutral-eval-'));
  const fixturePath = join(tempDir, 'train.jsonl');
  const record = buildTrainingRecord({
    example: {
      ...seedExample,
      segments: [
        { id: 'subtitle-1', startMs: 0, endMs: 1200, text: '这里检查状态和输出' },
      ],
    },
    teacherResult: {
      segments: [{ id: 'subtitle-1', text: '这里检查状态和输出' }],
      chapters: [{ title: '状态检查', startMs: 0, endMs: 1200 }],
    },
    teacherModel: 'gpt-5.5',
  });

  try {
    writeFileSync(fixturePath, `${JSON.stringify(record)}\n`);
    const result = spawnSync('node', ['scripts/subtitle-llm/evaluate-corpus.mjs', fixturePath], {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    const metrics = JSON.parse(result.stdout);
    assert.equal(metrics.jsonValidRate, 1);
    assert.equal(Object.hasOwn(metrics, 'simplifiedChineseRate'), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('LoRA merge falls back to the base model tokenizer for adapter-only directories', () => {
  const python = [
    'import importlib.util',
    'spec = importlib.util.spec_from_file_location("merge_lora", "ml/subtitle-postprocessor/merge_lora.py")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'class FakeTokenizer:',
    '    calls = []',
    '    @classmethod',
    '    def from_pretrained(cls, source, trust_remote_code=False):',
    '        cls.calls.append((source, trust_remote_code))',
    '        if source == "adapter-only":',
    '            raise OSError("missing tokenizer")',
    '        return {"source": source, "trust": trust_remote_code}',
    'tokenizer = module.load_tokenizer(FakeTokenizer, "adapter-only", "base-model", True)',
    'print(tokenizer["source"])',
    'print(FakeTokenizer.calls)',
  ].join('\n');
  const result = spawnSync('python3', ['-c', python], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /base-model/);
  assert.match(result.stdout, /\('adapter-only', True\).*'base-model'/s);
});

test('LoRA training script rejects remote code trust with hub publishing', () => {
  const fakeHfToken = `${'h'}${'f'}_${'c'.repeat(30)}`;
  const result = spawnSync(
    'python3',
    [
      'ml/subtitle-postprocessor/train_lora.py',
      '--train-jsonl',
      'train.jsonl',
      '--trust-remote-code',
      '--hub-model-id',
      'ceilf6/test-model',
    ],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
      env: { ...process.env, HF_TOKEN: fakeHfToken },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Do not combine --trust-remote-code with --hub-model-id/);
});

test('LoRA training script validates JSONL messages before loading ML dependencies', () => {
  const result = runTrainingValidation('scripts/tests/fixtures/malformed-subtitle-train.jsonl');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must contain a messages list/);
});

test('LoRA training script rejects records without strict subtitle SFT turns', () => {
  const result = runTrainingValidation('scripts/tests/fixtures/bad-role-subtitle-train.jsonl');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /messages\[0\]\.role must be system/);
});

test('LoRA training script rejects assistant content that is not JSON', () => {
  const result = runTrainingValidation('scripts/tests/fixtures/non-json-assistant-subtitle-train.jsonl');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /assistant content is not valid JSON/);
});

test('LoRA training script rejects subtitle records without required chapters', () => {
  const result = runTrainingValidation('scripts/tests/fixtures/missing-chapters-subtitle-train.jsonl');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /assistant JSON must contain segments and chapters arrays/);
});

test('LoRA training script rejects subtitle records with empty chapters', () => {
  const result = runTrainingValidation('scripts/tests/fixtures/empty-chapters-subtitle-train.jsonl');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /chapters must contain at least one chapter/);
});

test('LoRA training script rejects secret-like training records before loading ML dependencies', () => {
  const fakeHfToken = `${'h'}${'f'}_${'d'.repeat(30)}`;
  const tempDir = mkdtempSync(join(tmpdir(), 'subtitle-secret-train-'));
  const fixturePath = join(tempDir, 'secret-train.jsonl');
  const record = {
    messages: [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: JSON.stringify({
          context: { runtimeOutput: `never train ${fakeHfToken}` },
          segments: [{ id: 'subtitle-1', startMs: 0, endMs: 1200, text: '原始字幕' }],
        }),
      },
      {
        role: 'assistant',
        content: JSON.stringify({
          segments: [{ id: 'subtitle-1', text: '原始字幕' }],
          chapters: [{ title: '状态设计', startMs: 0, endMs: 1200 }],
        }),
      },
    ],
  };

  try {
    writeFileSync(fixturePath, `${JSON.stringify(record)}\n`);
    const result = runTrainingValidation(fixturePath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /secret-like value/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('LoRA training JSONL validator accepts a complete subtitle SFT contract', () => {
  const python = [
    'import importlib.util',
    'spec = importlib.util.spec_from_file_location("train_lora", "ml/subtitle-postprocessor/train_lora.py")',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'module.validate_train_jsonl("scripts/tests/fixtures/valid-subtitle-train.jsonl")',
    'print("ok")',
  ].join('; ');
  const result = spawnSync('python3', ['-c', python], {
    cwd: new URL('../..', import.meta.url),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'ok');
});

test('LoRA training JSONL validator accepts sparse subtitle corrections', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'subtitle-sparse-train-'));
  const fixturePath = join(tempDir, 'sparse-train.jsonl');
  const record = {
    messages: [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: JSON.stringify({
          segments: [
            { id: 'subtitle-1', startMs: 0, endMs: 1200, text: '原始字幕' },
            { id: 'subtitle-2', startMs: 1200, endMs: 2600, text: '继续讲 use state' },
          ],
        }),
      },
      {
        role: 'assistant',
        content: JSON.stringify({
          segments: [{ id: 'subtitle-2', text: '继续讲 useState' }],
          chapters: [{ title: '状态设计', startMs: 0, endMs: 2600 }],
        }),
      },
    ],
  };

  try {
    writeFileSync(fixturePath, `${JSON.stringify(record)}\n`);
    const python = [
      'import importlib.util',
      'spec = importlib.util.spec_from_file_location("train_lora", "ml/subtitle-postprocessor/train_lora.py")',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      `module.validate_train_jsonl(${JSON.stringify(fixturePath)})`,
      'print("ok")',
    ].join('; ');
    const result = spawnSync('python3', ['-c', python], {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'ok');
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('LoRA training JSONL validator accepts inputSegments as the prompt-side subtitle field', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'subtitle-input-segments-train-'));
  const fixturePath = join(tempDir, 'train.jsonl');
  writeFileSync(
    fixturePath,
    `${JSON.stringify({
      messages: [
        { role: 'system', content: 'Only output JSON.' },
        {
          role: 'user',
          content: JSON.stringify({
            inputSegments: [
              { id: 'subtitle-1', startMs: 0, endMs: 1200, text: '继续讲 use state' },
            ],
          }),
        },
        {
          role: 'assistant',
          content: JSON.stringify({
            segments: [{ id: 'subtitle-1', text: '继续讲 useState' }],
            chapters: [{ title: '状态设计', startMs: 0, endMs: 1200 }],
          }),
        },
      ],
    })}\n`,
  );
  const result = spawnSync(
    'python3',
    [
      '-c',
      [
        'import importlib.util',
        'spec = importlib.util.spec_from_file_location("train_lora", "ml/subtitle-postprocessor/train_lora.py")',
        'module = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(module)',
        `module.validate_train_jsonl(${JSON.stringify(fixturePath)})`,
      ].join(';'),
    ],
    { cwd: new URL('../..', import.meta.url), encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
});

test('dataset validator rejects empty JSONL input', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'subtitle-empty-dataset-'));
  const fixturePath = join(tempDir, 'empty.jsonl');

  try {
    writeFileSync(fixturePath, '');
    const result = spawnSync('node', ['scripts/subtitle-llm/validate-dataset.mjs', fixturePath], {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /must contain at least one subtitle fine-tuning record/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('LoRA training JSONL validator rejects non-object inputSegments entries', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'subtitle-bad-input-segments-train-'));
  const fixturePath = join(tempDir, 'train.jsonl');
  writeFileSync(
    fixturePath,
    `${JSON.stringify({
      messages: [
        { role: 'system', content: 'Only output JSON.' },
        {
          role: 'user',
          content: JSON.stringify({
            inputSegments: [
              { id: 'subtitle-1', startMs: 0, endMs: 1200, text: '继续讲 use state' },
              'bad-segment',
            ],
          }),
        },
        {
          role: 'assistant',
          content: JSON.stringify({
            segments: [{ id: 'subtitle-1', text: '继续讲 useState' }],
            chapters: [{ title: '状态设计', startMs: 0, endMs: 1200 }],
          }),
        },
      ],
    })}\n`,
  );

  try {
    const result = runTrainingValidation(fixturePath);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /user segments\[1\] must be an object/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('distillation CLI rejects empty seed JSONL without writing output', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'subtitle-empty-distill-'));
  const seedPath = join(tempDir, 'empty-seed.jsonl');
  const outPath = join(tempDir, 'distilled.jsonl');

  try {
    writeFileSync(seedPath, '');
    const result = spawnSync(
      'node',
      ['scripts/subtitle-llm/distill-corpus.mjs', '--seed', seedPath, '--out', outPath],
      {
        cwd: new URL('../..', import.meta.url),
        encoding: 'utf8',
        env: { ...process.env, TEACHER_API_KEY: 'test-teacher-key' },
      },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /seed dataset must contain at least one distillation example/);
    assert.equal(existsSync(outPath), false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function runTrainingValidation(fixturePath) {
  return spawnSync(
    'python3',
    [
      'ml/subtitle-postprocessor/train_lora.py',
      '--train-jsonl',
      fixturePath,
    ],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
    },
  );
}
