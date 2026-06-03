# Idle Auto Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically run recorder code after 2 seconds without code input, while preserving the existing run button and shortcut behavior.

**Architecture:** `CodeEditor` reports real model content changes through a focused callback. `RecorderPage` debounces those changes and calls the existing `handleRun` path so runtime event emission, pause guards, output rendering, and error handling stay centralized.

**Tech Stack:** React, TypeScript, Monaco Editor, Vitest, Testing Library.

---

### Task 1: Add Debounced Auto Run

**Files:**
- Modify: `apps/web/src/features/editor/CodeEditor.tsx`
- Modify: `apps/web/src/features/recorder/RecorderPage.tsx`
- Test: `apps/web/src/features/recorder/__tests__/RecorderPage.test.tsx`

- [ ] **Step 1: Write the failing test**

Add a recorder page test that renders the page with fake timers, invokes `codeEditorProps.onChange`, advances 1,999 ms, verifies no run, advances 1 ms, then verifies the existing runtime producer was called with the current editor source.

- [ ] **Step 2: Run the failing test**

Run: `npm run test:web -- RecorderPage.test.tsx -t "automatically runs changed code after the editor is idle"`

Expected: FAIL because `CodeEditorProps` has no `onChange` callback and `RecorderPage` does not schedule idle runs.

- [ ] **Step 3: Implement the minimal code**

Add `onChange?(): void` to `CodeEditorProps`, store it in a ref, and call it from `editor.onDidChangeModelContent`. In `RecorderPage`, add `AUTO_RUN_IDLE_MS = 2000`, schedule a timeout from the editor change callback, clear the old timeout on new input, clear on unmount, and call the existing `handleRun` when the timer fires.

- [ ] **Step 4: Run targeted tests**

Run: `npm run test:web -- RecorderPage.test.tsx CodeEditor.test.tsx`

Expected: PASS.

- [ ] **Step 5: Run required quality gates**

Run: `npm run contract:gitnexus`, then `npm run quality:precommit`, then `npm run quality:local`.

Expected: all pass. Summarize GitNexus advice before pushing.
