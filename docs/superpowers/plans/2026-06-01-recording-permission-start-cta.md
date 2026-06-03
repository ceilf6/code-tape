# Recording Permission Start CTA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make recording startup request browser media permission first, and make the permission CTA the first visible setup control.

**Architecture:** Keep the behavior local to `RecorderPage` and the presentational layout local to `RecorderSetupToolbar`. The recorder continues to use existing `MediaDevicesController` APIs and existing event-only fallback behavior when media is denied or unavailable.

**Tech Stack:** React, TypeScript, Vitest, Testing Library, lucide-react.

---

### Task 1: Permission Request On Start

**Files:**
- Modify: `apps/web/src/features/recorder/RecorderPage.tsx`
- Test: `apps/web/src/features/recorder/__tests__/RecorderPage.test.tsx`

- [ ] **Step 1: Write the failing test**

Add a test that clicks `开始录制`, expects `requestPermission("audio")` and `requestPermission("camera")` before `openStream`, and expects enumeration to refresh before opening media.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- src/features/recorder/__tests__/RecorderPage.test.tsx`
Expected: FAIL because `handleStart` currently opens the selected stream without calling `requestPermission`.

- [ ] **Step 3: Write minimal implementation**

Extract a helper in `RecorderPage.tsx` that requests both permissions and reloads devices. Call it from `handleStart` before selecting devices. Preserve explicit `无麦克风` / `无摄像头` selections.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -w apps/web -- src/features/recorder/__tests__/RecorderPage.test.tsx`
Expected: PASS.

### Task 2: Move And Emphasize Permission CTA

**Files:**
- Modify: `apps/web/src/features/recorder/RecorderPage.tsx`
- Test: `apps/web/src/features/recorder/__tests__/RecorderPage.test.tsx`

- [ ] **Step 1: Write the failing test**

Add a test that verifies `申请设备权限` appears before `麦克风设备` in the setup toolbar.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -w apps/web -- src/features/recorder/__tests__/RecorderPage.test.tsx`
Expected: FAIL because the permission button currently appears after media device selectors.

- [ ] **Step 3: Write minimal implementation**

Move the permission button to the left side of `RecorderSetupToolbar`, before language and device selectors, and give it visible text beside the shield icon using existing button styling.

- [ ] **Step 4: Run focused tests**

Run: `npm run test -w apps/web -- src/features/recorder/__tests__/RecorderPage.test.tsx src/features/recorder/__tests__/RecorderControls.test.tsx`
Expected: PASS.

### Task 3: Final Verification And GitNexus Advice

**Files:**
- No production file changes beyond Tasks 1-2.

- [ ] **Step 1: Run web lint and focused tests**

Run: `npm run lint:web`
Run: `npm run test -w apps/web -- src/features/recorder/__tests__/RecorderPage.test.tsx src/features/recorder/__tests__/RecorderControls.test.tsx`

- [ ] **Step 2: Read GitNexus diff advice**

Run: `npx gitnexus detect_changes` if available, otherwise use the repository's GitNexus contract command output and summarize the advisory result.

- [ ] **Step 3: Review diff**

Run: `git diff -- apps/web/src/features/recorder/RecorderPage.tsx apps/web/src/features/recorder/__tests__/RecorderPage.test.tsx`
