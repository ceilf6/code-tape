# DOMPurify Preview Sanitization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen static and replay preview HTML sanitization with DOMPurify without changing executable iframe runtime behavior.

**Architecture:** DOMPurify is scoped to the runtime preview sanitizer in `apps/web/src/features/runtime-preview/iframeRuntime.ts`. Static preview and `renderDocument` output are sanitized before building the no-script replay iframe srcdoc, while JS/TS execution continues to rely on the existing iframe sandbox, CSP, timeout, and message validation controls.

**Tech Stack:** Vite, React, TypeScript, Vitest, jsdom, DOMPurify.

---

## File Structure

- Modify `apps/web/package.json`: add `dompurify` as a web runtime dependency.
- Modify `package-lock.json`: lock the installed DOMPurify version.
- Modify `apps/web/src/features/runtime-preview/iframeRuntime.ts`: replace the local script-only sanitizer with DOMPurify for static/replay preview HTML.
- Modify `apps/web/src/features/runtime-preview/__tests__/iframeRuntime.test.ts`: add sanitizer tests for event handler attributes and `javascript:` URLs while preserving existing static content behavior.

No React component should import DOMPurify directly. The sanitizer boundary stays in the runtime preview module.

## Task 1: Add DOMPurify Dependency

**Files:**
- Modify: `apps/web/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install DOMPurify in the web workspace**

Run:

```bash
npm install dompurify -w apps/web
```

Expected:

```text
added 1 package
```

The exact npm audit text may vary. The important result is that `apps/web/package.json` contains:

```json
"dompurify": "^3.4.7"
```

- [ ] **Step 2: Confirm package metadata changed only for the dependency**

Run:

```bash
git diff -- apps/web/package.json package-lock.json
```

Expected: `apps/web/package.json` adds `dompurify` under `dependencies`, and `package-lock.json` adds the matching package resolution.

## Task 2: Add Failing Sanitizer Tests

**Files:**
- Modify: `apps/web/src/features/runtime-preview/__tests__/iframeRuntime.test.ts`

- [ ] **Step 1: Add tests that prove the current sanitizer is insufficient**

Insert these tests in the `IframeRuntime sandbox lifecycle` describe block near the existing replay preview sanitizer tests:

```ts
  it("removes inline event handlers from replay preview HTML", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    await runtime.renderPreview('<body><button onclick="window.__clicked = true">Click</button></body>');
    const frame = host.querySelector("iframe");

    expect(frame?.srcdoc).toContain("<button>Click</button>");
    expect(frame?.srcdoc).not.toMatch(/onclick/i);
    runtime.destroy();
    host.remove();
  });

  it("removes javascript URLs from replay preview HTML", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    await runtime.renderPreview('<body><a href="javascript:alert(1)">link</a></body>');
    const frame = host.querySelector("iframe");

    expect(frame?.srcdoc).toContain(">link</a>");
    expect(frame?.srcdoc).not.toMatch(/javascript:/i);
    runtime.destroy();
    host.remove();
  });

  it("returns persisted renderDocument markup without active HTML handlers or javascript URLs", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const runtime = createIframeRuntime();

    await runtime.mount(host);
    const returned = await runtime.renderDocument(
      '<body><h1 onclick="window.__x = 1">hello</h1><a href="javascript:alert(1)">link</a></body>',
    );

    expect(returned).toContain("<h1>hello</h1>");
    expect(returned).toContain(">link</a>");
    expect(returned).not.toMatch(/onclick|javascript:/i);
    runtime.destroy();
    host.remove();
  });
```

- [ ] **Step 2: Run the targeted test and verify it fails before implementation**

Run:

```bash
npm run test -w apps/web -- iframeRuntime
```

Expected: FAIL. At least one new test should fail because the current sanitizer removes `<script>` but does not remove inline event handlers or `javascript:` URLs.

## Task 3: Replace Preview Sanitization With DOMPurify

**Files:**
- Modify: `apps/web/src/features/runtime-preview/iframeRuntime.ts`

- [ ] **Step 1: Import DOMPurify**

Add this import at the top of `iframeRuntime.ts`:

```ts
import DOMPurify, { type Config as DOMPurifyConfig } from "dompurify";
```

- [ ] **Step 2: Add an explicit preview sanitizer config**

Add this near the CSP constants:

```ts
const PREVIEW_SANITIZE_CONFIG = {
  WHOLE_DOCUMENT: true,
} satisfies DOMPurifyConfig;
```

- [ ] **Step 3: Update `sanitizePreviewHtml` to call DOMPurify**

Replace the existing `sanitizePreviewHtml` and `sanitizePreviewHtmlWithoutParser` functions with:

```ts
function sanitizePreviewHtml(previewHtml: string): SanitizedPreviewHtml {
  const cappedPreviewHtml = limitString(previewHtml, RUNTIME_PREVIEW_HTML_MAX_CHARS);
  if (typeof DOMParser === "undefined") {
    throw new Error("IframeRuntime: DOMParser is required to sanitize preview HTML");
  }
  const sanitizedHtml = DOMPurify.sanitize(cappedPreviewHtml, PREVIEW_SANITIZE_CONFIG);
  const doc = new DOMParser().parseFromString(sanitizedHtml, "text/html");
  return {
    headHtml: limitString(doc.head?.innerHTML ?? "", RUNTIME_PREVIEW_HTML_MAX_CHARS),
    bodyHtml: limitString(doc.body?.outerHTML ?? "<body></body>", RUNTIME_PREVIEW_HTML_MAX_CHARS),
  };
}
```

This intentionally fails explicitly without DOMParser. The app targets modern desktop browsers for P0, and silently rendering unsanitized fallback HTML would violate the design.

- [ ] **Step 4: Keep executable runtime behavior unchanged**

Confirm `run(input)` still builds executable srcdoc through:

```ts
const frame = await createRuntimeIframe(sandboxFlags, buildSrcDoc(IFRAME_BOOT_SCRIPT, theme));
```

Do not add DOMPurify to `run(input)` or `acceptRuntimeMessage`.

## Task 4: Verify Tests and Build Surface

**Files:**
- Modify: no additional files expected

- [ ] **Step 1: Run the targeted runtime preview tests**

Run:

```bash
npm run test -w apps/web -- iframeRuntime
```

Expected: PASS. The output should include:

```text
✓ src/features/runtime-preview/__tests__/iframeRuntime.test.ts
```

- [ ] **Step 2: Run web lint**

Run:

```bash
npm run lint:web
```

Expected:

```text
> lint:web
> npm run lint -w apps/web
```

No ESLint errors.

- [ ] **Step 3: Run web tests**

Run:

```bash
npm run test:web
```

Expected: PASS for the web Vitest suite.

## Task 5: Read GitNexus Advice and Commit

**Files:**
- Modify: no additional source files expected

- [ ] **Step 1: Read GitNexus change advice**

Run:

```bash
npm run contract:gitnexus
```

Expected: GitNexus reports advisory impact for the dependency and runtime preview sanitizer changes. Capture the key symbols or files it names for the PR self-check.

- [ ] **Step 2: Review final diff**

Run:

```bash
git diff -- apps/web/package.json package-lock.json apps/web/src/features/runtime-preview/iframeRuntime.ts apps/web/src/features/runtime-preview/__tests__/iframeRuntime.test.ts
```

Expected:

- `dompurify` dependency added.
- `iframeRuntime.ts` imports DOMPurify and sanitizes only static/replay preview HTML.
- Tests cover `<script>`, inline event handlers, `javascript:` URLs, and preserved static content.
- No executable runtime sandbox flags or runtime message validation behavior changed.

- [ ] **Step 3: Commit the implementation**

Run:

```bash
git add apps/web/package.json package-lock.json apps/web/src/features/runtime-preview/iframeRuntime.ts apps/web/src/features/runtime-preview/__tests__/iframeRuntime.test.ts
git commit -m "feat: sanitize preview HTML with DOMPurify"
```

Expected: commit succeeds after the pre-commit hook runs `npm run quality:precommit`.

## Self-Review

- Spec coverage: Task 3 scopes DOMPurify to static/replay preview only; Task 2 covers script, event handler, and `javascript:` sanitizer behavior; Task 4 covers verification; Task 5 covers GitNexus advice.
- Placeholder scan: no unfinished placeholder instructions are used.
- Type consistency: `DOMPurifyConfig`, `PREVIEW_SANITIZE_CONFIG`, and `sanitizePreviewHtml` names are introduced before use and match later references.
