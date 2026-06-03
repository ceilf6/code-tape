# GitHub Pages Deployment Design

## Goal

Deploy the Vite React web app to the project page `https://ceilf6.github.io/code-tape/`.

## Approach

Use GitHub Actions with the official GitHub Pages actions. The deployment workflow builds `apps/web`, uploads `apps/web/dist`, and deploys it to Pages after the repository quality gates run inside the same workflow.

## Routing And Assets

The normal local developer path stays rooted at `/`. Pages builds set `GITHUB_PAGES=true`, which makes Vite emit asset URLs under `/code-tape/`. React Router derives its basename from `import.meta.env.BASE_URL`, so links and direct navigation work under the project-page prefix without changing local dev or e2e routes.

The workflow copies `apps/web/dist/index.html` to `apps/web/dist/404.html` after the Pages build. This gives GitHub Pages a fallback document for direct SPA routes such as `/code-tape/record`.

## Files

- `.github/workflows/pages.yml`: build, verify, upload, and deploy the Pages artifact.
- `apps/web/vite.config.ts`: switch Vite base to `/code-tape/` only for Pages builds.
- `apps/web/src/app/routerBase.ts`: normalize `import.meta.env.BASE_URL` into a React Router basename.
- `apps/web/src/app/routes.tsx`: pass the normalized basename to `createBrowserRouter`.
- `apps/web/src/app/__tests__/routerBase.test.ts`: verify local and Pages basename behavior.
- `scripts/tests/workflow-rules.test.mjs`: enforce the deploy workflow contract.

## Verification

- `npm test`
- `npm run test:web`
- `npm run build`
- `GITHUB_PAGES=true npm run build`
- `npm run quality:local`
- GitNexus `detect_changes`
