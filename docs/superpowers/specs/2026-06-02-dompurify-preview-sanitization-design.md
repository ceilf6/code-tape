# DOMPurify Preview Sanitization Design

## Context

`docs/PRD.md` requires the project to support frontend code display or execution without polluting the host application. `docs/技术方案.md` chooses iframe sandbox preview as the P0 runtime route and defines the key invariants: executable runtime messages must be validated by `event.source`, `runId`, and schema; replay preview must render inside a sandbox iframe; runtime timeout must destroy the iframe.

The current implementation already follows that direction in `apps/web/src/features/runtime-preview/iframeRuntime.ts`:

- executable JavaScript / TypeScript runs in a sandbox iframe with `allow-scripts`;
- runtime srcdoc includes CSP, message schema validation, run id checks, source checks, timeout teardown, and output caps;
- static and replay preview render in a no-script sandbox iframe;
- static preview HTML is currently sanitized by a local helper that caps size and removes `<script>` nodes.

The weak point is the local preview sanitizer. Removing only script elements is not a complete XSS sanitization strategy for persisted or replayed HTML. DOMPurify should strengthen this static preview boundary without changing the executable iframe sandbox contract.

## Goals

- Use DOMPurify for static preview and replay preview HTML sanitization.
- Keep DOMPurify scoped to `renderPreview` and `renderDocument` style paths.
- Preserve the current iframe sandbox, replay CSP, runtime CSP, timeout teardown, and message validation behavior.
- Preserve benign static HTML and CSS that are useful for code teaching demos, including `<style>`, ordinary attributes, classes, and body content.
- Persist the sanitized HTML returned by `renderDocument`, so future replay paths do not store script-bearing markup.

## Non-Goals

- Do not sanitize JavaScript / TypeScript source code before execution.
- Do not sanitize DOM mutations produced while user code is actively running in the executable iframe.
- Do not make DOMPurify the only security boundary.
- Do not expand runtime capabilities, sandbox flags, network permissions, package loading, or WebContainers behavior.
- Do not introduce broad security refactors outside runtime preview sanitization.

## Recommended Approach

Replace the local script-stripping sanitizer with DOMPurify for static preview HTML. Keep the public runtime surface the same:

- `createIframeRuntime().renderPreview(previewHtml)` sanitizes `previewHtml`, builds replay srcdoc, and writes it into a no-script sandbox iframe.
- `createIframeRuntime().renderDocument(html)` sanitizes `html`, renders the sanitized srcdoc, and returns the sanitized markup for persistence.
- `createIframeRuntime().run(input)` remains unchanged except that completed runtime preview HTML is still capped before being returned; executable runs are protected by the existing sandbox and CSP model rather than DOMPurify.

This approach adds a professional sanitizer where the current code already intends to sanitize static HTML, while avoiding surprising behavior changes for interactive demos.

## Architecture

The sanitizer boundary stays inside `apps/web/src/features/runtime-preview/iframeRuntime.ts` or a small sibling helper if the implementation becomes clearer. No React component should call DOMPurify directly.

Sanitization flow:

1. Cap incoming preview HTML to `RUNTIME_PREVIEW_HTML_MAX_CHARS`.
2. Pass the capped HTML through DOMPurify.
3. Parse the sanitized document into head and body fragments for `buildPreviewSrcDoc`.
4. Build replay srcdoc with the existing `REPLAY_PREVIEW_CSP`.
5. Render it inside an iframe with an empty sandbox attribute.
6. For `renderDocument`, return the sanitized markup that was actually rendered.

DOMPurify configuration should be explicit and small. It should remove active script execution vectors such as `<script>`, event handler attributes, and `javascript:` URLs while keeping static teaching content like `<style>`, headings, paragraphs, buttons, classes, and inline styles.

## Data Flow

Static HTML/CSS run:

1. `runtimeProducer` calls `runtime.renderDocument(...)`.
2. `iframeRuntime` sanitizes the HTML with DOMPurify.
3. The sanitized document is rendered in a no-script iframe.
4. The sanitized markup is emitted as `run-output.previewHtml`.
5. Recording package persistence stores script-free preview HTML.

Replay preview:

1. Replay loads historical `previewHtml`.
2. `iframeRuntime.renderPreview(...)` sanitizes it again before rendering.
3. The sanitized document is rendered in a no-script iframe with replay CSP.

Executable JS/TS run:

1. `runtimeProducer` compiles user code.
2. `iframeRuntime.run(...)` creates the executable sandbox iframe.
3. User code runs under existing runtime CSP, sandbox flags, message validation, timeout teardown, and output caps.
4. DOMPurify does not alter this path.

## Error Handling

- If DOMPurify or DOM parsing fails unexpectedly, `renderPreview` and `renderDocument` should fail explicitly through the existing runtime producer error path instead of silently rendering unsanitized HTML.
- Size capping remains in place before and after sanitization to keep memory and recording size bounded.
- The fallback sanitizer for environments without DOM APIs should not be expanded unless tests show it is needed for the current browser-focused app. The P0 target remains modern desktop Chrome / Edge.

## Testing

Update `apps/web/src/features/runtime-preview/__tests__/iframeRuntime.test.ts` to cover:

- `<script>` elements are removed from replay preview and persisted `renderDocument` output.
- inline event handler attributes such as `onclick` are removed.
- `javascript:` URL attributes are removed or made inert.
- non-script static content is preserved, including `<style>`, classes, body content, and ordinary elements.
- `renderPreview` still uses an empty sandbox attribute.
- `renderDocument` still returns sanitized markup rather than the original input.

Existing runtime lifecycle tests should continue to prove:

- executable runtime srcdoc includes the technical-plan CSP;
- timeout destroys the run iframe;
- runtime message acceptance still checks source, run id, and schema;
- static preview and executable runtime behavior remain separated.

## Success Criteria

- DOMPurify is installed in the web app dependency graph.
- Static and replay preview HTML sanitizer tests cover script tags, event handlers, and `javascript:` URLs.
- Current runtime preview tests pass.
- `npm run test:web -- iframeRuntime` or the nearest supported targeted test command passes.
- `npm run quality:precommit` passes before PR creation.

## PR Self-Check Notes

- Mention that DOMPurify is scoped to static/replay preview sanitization only.
- Mention that executable JS/TS iframe runtime behavior is intentionally unchanged.
- Summarize GitNexus impact analysis for touched runtime preview symbols after implementation.
