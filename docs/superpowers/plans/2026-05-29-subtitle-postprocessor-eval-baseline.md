# Subtitle Postprocessor Evaluation Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a small repeatable evaluation baseline for "纠错并生成章节" quality and timing.

**Architecture:** Keep the baseline in Node scripts so it can run in CI without loading the browser LLM. Fixtures contain representative subtitle tracks plus model-like JSON outputs; the evaluator validates JSON, sparse segment references, expected term corrections, chapter timelines, and records per-sample duration.

**Tech Stack:** Node.js ESM, `node:test`, JSON fixtures, existing npm workflow scripts.

---

### Task 1: Evaluation Fixtures And Red Tests

**Files:**
- Create: `scripts/tests/fixtures/subtitle-postprocessor-eval.json`
- Modify: `scripts/tests/subtitle-finetune.test.mjs`
- Modify: `.github/PULL_REQUEST_TEMPLATE.md`

- [ ] **Step 1: Add fixtures**

Create `scripts/tests/fixtures/subtitle-postprocessor-eval.json` with three representative samples and four negative samples:

```json
{
  "samples": [
    {
      "id": "react-state-render",
      "kind": "representative",
      "track": {
        "recordingId": "eval-react-state-render",
        "generatedAt": "2026-05-29T00:00:00.000Z",
        "model": "onnx-community/whisper-tiny",
        "source": "huggingface-local",
        "language": "zh",
        "segments": [
          { "id": "subtitle-1", "startMs": 0, "endMs": 1200, "text": "这里用 use state 维护 count" },
          { "id": "subtitle-2", "startMs": 1200, "endMs": 2600, "text": "然后 set count 触发 render" },
          { "id": "subtitle-3", "startMs": 2600, "endMs": 4200, "text": "最后看 render result" }
        ]
      },
      "output": "{\"segments\":[{\"id\":\"subtitle-1\",\"text\":\"这里用 useState 维护 count\"},{\"id\":\"subtitle-2\",\"text\":\"然后 setCount 触发 render\"}],\"chapters\":[{\"title\":\"状态设计\",\"startMs\":0,\"endMs\":2600},{\"title\":\"渲染验证\",\"startMs\":2600,\"endMs\":4200}]}",
      "expectedCorrections": [
        { "id": "subtitle-1", "contains": ["useState"], "notContains": ["use state"] },
        { "id": "subtitle-2", "contains": ["setCount"], "notContains": ["set count"] }
      ],
      "expectedTerms": ["useState", "setCount", "render"],
      "expectedChapters": ["状态设计", "渲染验证"]
    }
  ]
}
```

- [ ] **Step 2: Write failing tests**

Add tests that import `evaluatePostprocessorFixtures` from `scripts/subtitle-llm/evaluate-postprocessor.mjs`, assert representative metrics hit 1.0, assert negative fixtures expose unknown segment, duplicate segment, invalid JSON, and invalid chapter timeline, and assert the PR template asks for one "纠错并生成章节" verification result.

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
node --test scripts/tests/subtitle-finetune.test.mjs
```

Expected: fail because `scripts/subtitle-llm/evaluate-postprocessor.mjs` does not exist yet.

### Task 2: Evaluation Command

**Files:**
- Create: `scripts/subtitle-llm/evaluate-postprocessor.mjs`
- Modify: `package.json`
- Modify: `docs/技术方案.md`

- [ ] **Step 1: Implement evaluator**

Create a script exporting `evaluatePostprocessorFixtures`, `loadPostprocessorFixtureFile`, and `assertPostprocessorEvaluationGate`. It should parse each output, validate sparse `segments`, apply legal corrections, validate `chapters`, compute hit rates and duration metrics, and expose negative failure categories.

- [ ] **Step 2: Add npm command**

Add:

```json
"subtitle:postprocess:evaluate": "node scripts/subtitle-llm/evaluate-postprocessor.mjs scripts/tests/fixtures/subtitle-postprocessor-eval.json"
```

- [ ] **Step 3: Document the baseline**

In `docs/技术方案.md`, add that runtime postprocessor changes must run `npm run subtitle:postprocess:evaluate` and paste the JSON metrics into PR self-check.

- [ ] **Step 4: Run tests to verify GREEN**

Run:

```bash
node --test scripts/tests/subtitle-finetune.test.mjs
npm run subtitle:postprocess:evaluate
```

Expected: both pass; command prints JSON metrics including effect rates and duration fields.

### Task 3: Full Verification And PR

**Files:**
- All modified files above.

- [ ] **Step 1: Run local quality gates**

Run:

```bash
npm run quality:local
```

Expected: pass.

- [ ] **Step 2: Open PR**

Create a PR with `Closes #135`, include one `npm run subtitle:postprocess:evaluate` output summary, then wait for GitHub Actions, repo-guard, Codex, and Copilot feedback.
