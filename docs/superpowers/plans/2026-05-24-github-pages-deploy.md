# GitHub Pages Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the Vite React app to `https://ceilf6.github.io/code-tape/`.

**Architecture:** GitHub Actions builds a Pages-specific artifact from `apps/web/dist` and deploys it with official Pages actions. The app keeps local development at `/`, while Pages builds use `/code-tape/` as both the Vite asset base and React Router basename.

**Tech Stack:** GitHub Actions, GitHub Pages, Vite, React Router, Vitest, Node test runner.

---

### Task 1: Lock The Workflow Contract

**Files:**
- Modify: `scripts/tests/workflow-rules.test.mjs`
- Create: `.github/workflows/pages.yml`

- [ ] **Step 1: Write the failing workflow test**

Add a Node test that reads `.github/workflows/pages.yml` and asserts the workflow deploys only from `main` or manual dispatch, grants `pages: write` and `id-token: write`, runs a Pages build with `GITHUB_PAGES=true`, creates `404.html`, uploads `apps/web/dist`, and uses `actions/deploy-pages`.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test`

Expected: FAIL because `.github/workflows/pages.yml` does not exist yet.

- [ ] **Step 3: Add the Pages workflow**

Create `.github/workflows/pages.yml` with separate `build` and `deploy` jobs. The build job installs dependencies, runs repository and web quality checks, runs `GITHUB_PAGES=true npm run build`, copies `index.html` to `404.html`, and uploads `apps/web/dist`. The deploy job uses `actions/deploy-pages`.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm test`

Expected: PASS.

### Task 2: Add Pages Base Routing

**Files:**
- Modify: `apps/web/vite.config.ts`
- Create: `apps/web/src/app/routerBase.ts`
- Create: `apps/web/src/app/__tests__/routerBase.test.ts`
- Modify: `apps/web/src/app/routes.tsx`

- [ ] **Step 1: Write the failing basename test**

Create a Vitest test for `normalizeRouterBasename`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeRouterBasename } from "../routerBase";

describe("normalizeRouterBasename", () => {
  it("omits a basename for local root builds", () => {
    expect(normalizeRouterBasename("/")).toBeUndefined();
  });

  it("normalizes the GitHub Pages base without a trailing slash", () => {
    expect(normalizeRouterBasename("/code-tape/")).toBe("/code-tape");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm run test:web -- routerBase`

Expected: FAIL because `routerBase.ts` does not exist.

- [ ] **Step 3: Implement the basename helper and route wiring**

Create `routerBase.ts` with `normalizeRouterBasename(baseUrl: string)` and `routerBasename`. Update `routes.tsx` to pass `{ basename: routerBasename }` to `createBrowserRouter`.

- [ ] **Step 4: Configure Vite Pages base**

In `apps/web/vite.config.ts`, set `base` to `/code-tape/` only when `process.env.GITHUB_PAGES === "true"`.

- [ ] **Step 5: Run the focused test and verify it passes**

Run: `npm run test:web -- routerBase`

Expected: PASS.

### Task 3: Verify The Deployment Build

**Files:**
- No further edits expected.

- [ ] **Step 1: Build the normal local artifact**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 2: Build the Pages artifact**

Run: `GITHUB_PAGES=true npm run build`

Expected: PASS, with generated asset links prefixed by `/code-tape/`.

- [ ] **Step 3: Run local quality**

Run: `npm run quality:local`

Expected: PASS.

- [ ] **Step 4: Read GitNexus change advice**

Run: GitNexus `detect_changes` for the current diff and summarize the result.
