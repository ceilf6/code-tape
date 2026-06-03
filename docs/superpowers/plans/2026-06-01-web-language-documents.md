# Web Language Documents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve independent editor content per language while composing HTML, CSS, and the most recently selected JS/TS document into the iframe preview.

**Architecture:** Add document-aware editor state to the recording schema and replay reducer, then update the recorder page to swap Monaco content per selected language without changing the language selector UI. Update the runtime producer so runs receive all stored documents and assemble a single iframe document instead of rendering standalone CSS scaffolds.

**Tech Stack:** TypeScript, React, Monaco, Vitest, Node test runner, iframe sandbox runtime.

---

### Task 1: Schema And Replay State

**Files:**
- Modify: `packages/recording-schema/src/types.ts`
- Modify: `packages/recording-schema/src/replayState.ts`
- Test: `packages/recording-schema/src/replayState.test.ts`
- Test: `packages/recording-schema/src/validators.ts`
- Test: `apps/web/src/shared/recording-schema/__tests__/replayState.test.ts`

- [ ] **Step 1: Write failing replay reducer tests**

Add tests that build a recording with JavaScript content, switch to HTML, then switch back to JavaScript. Assert the final replay state keeps both documents and restores JavaScript as active.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w @code-tape/recording-schema -- replayState`
Expected: FAIL because `ReplayStableState` has only single-document editor state.

- [ ] **Step 3: Add document-aware types**

Add `RecordingDocumentState`, `RecordingEditorDocuments`, and `activeScriptLanguage` to editor replay state. Keep `editor.code` and `editor.language` as compatibility projections for current callers.

- [ ] **Step 4: Update reducer**

On `content-change`, write into `documents[event.payload.language]` and update the compatibility projection only when the changed language is active. On `language-change`, save active language and update `activeScriptLanguage` when the target is JavaScript or TypeScript.

- [ ] **Step 5: Run schema tests**

Run: `npm run test -w @code-tape/recording-schema`
Expected: PASS.

### Task 2: Runtime Document Composition

**Files:**
- Modify: `packages/recording-schema/src/types.ts`
- Modify: `apps/web/src/features/capture/runtimeProducer.ts`
- Test: `apps/web/src/features/capture/__tests__/runtimeProducer.test.ts`

- [ ] **Step 1: Write failing runtime producer tests**

Add tests that trigger runtime with a document map containing HTML, CSS, and JavaScript, then assert `renderDocument` receives HTML in body, CSS in style, and JS in module script.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:web -- runtimeProducer`
Expected: FAIL because `trigger` only accepts one source string.

- [ ] **Step 3: Extend trigger input**

Let `RuntimeProducerHandle.trigger` accept either the legacy `{ language, source }` input or the new `{ language, source, documents, activeScriptLanguage }` input.

- [ ] **Step 4: Compose preview document**

For HTML/CSS/JavaScript/TypeScript runs, build the iframe document from the complete document map. Escape closing `style` and `script` tags before interpolation.

- [ ] **Step 5: Run runtime tests**

Run: `npm run test:web -- runtimeProducer`
Expected: PASS.

### Task 3: Recorder Language Document State

**Files:**
- Modify: `apps/web/src/features/recorder/RecorderPage.tsx`
- Test: `apps/web/src/features/recorder/__tests__/RecorderPage.test.tsx`
- Test: `apps/web/src/features/editor/__tests__/CodeEditor.test.tsx`

- [ ] **Step 1: Write failing recorder integration test**

Add a test where the mocked editor starts in JavaScript, the user enters `console.log(1)`, switches to HTML, enters `<div>hi</div>`, switches back to JavaScript, and the editor receives `console.log(1)` again.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:web -- RecorderPage`
Expected: FAIL because one editor value is shared across languages.

- [ ] **Step 3: Track per-language documents**

In `RecorderPage`, keep a `documentsRef` map for JavaScript, TypeScript, HTML, CSS, and Python. Before switching language, capture editor value and view state for the current language. After switching, set the Monaco value and view state for the target language.

- [ ] **Step 4: Pass documents to runtime**

Before `handleRun` triggers runtime, flush and capture the active language document, then pass the full document map and active script language.

- [ ] **Step 5: Run recorder tests**

Run: `npm run test:web -- RecorderPage`
Expected: PASS.

### Task 4: Technical Plan Alignment

**Files:**
- Modify: `docs/技术方案.md`

- [ ] **Step 1: Update the event/runtime sections**

Revise the language payload examples so they include HTML and CSS where the implementation supports them, and document the multi-document editor model.

- [ ] **Step 2: Check documentation consistency**

Run: `npm test -- scripts/tests/workflow-rules.test.mjs`
Expected: PASS.

### Task 5: Full Verification And GitNexus

**Files:**
- No new source files.

- [ ] **Step 1: Read GitNexus diff advice**

Run: `npx gitnexus detect_changes --scope all` or use the GitNexus MCP `detect_changes` tool.
Expected: changed symbols and impacted flows are reviewed and summarized.

- [ ] **Step 2: Commit through hooks**

Run: `git add ... && git commit -m "feat: preserve web language documents"`
Expected: pre-commit `quality:precommit` passes.

- [ ] **Step 3: Final status**

Run: `git status --short --branch`
Expected: clean branch after commit.
