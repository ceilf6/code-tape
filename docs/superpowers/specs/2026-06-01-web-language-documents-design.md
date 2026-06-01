# Web Language Documents Design

## Context

The recorder currently exposes a single language selector with JavaScript,
TypeScript, HTML, CSS, and Python. The UI already allows choosing HTML and CSS,
but the underlying editor behaves like one mutable document whose Monaco
language changes over time. CSS preview is also limited because CSS is wrapped
around a generated sample HTML scaffold instead of applying to the user's HTML.

The product requirement is to keep the visible language list and switching
entry unchanged while making each language preserve its own editor page state.

## Goals

- Keep the existing language choices: JavaScript, TypeScript, HTML, CSS, Python.
- Keep the existing language selector as the switching entry.
- Preserve independent content and editor view state per language.
- Map HTML, CSS, and the active script language into one iframe preview.
- Continue recording and replaying language switches with stable behavior.

## Non-Goals

- Do not replace the language selector with tabs.
- Do not remove TypeScript or Python from the language list.
- Do not execute Python in the iframe.
- Do not change the visible recorder layout as part of this design.

## Product Behavior

Each language has its own editor page. When a user writes `console.log(1)` in
JavaScript, switches to HTML, writes `<div>hi</div>`, then switches back to
JavaScript, the editor restores the JavaScript document with `console.log(1)`
and its last known cursor, selection, and scroll state.

Running the preview combines the stored documents:

- HTML is written into the iframe body.
- CSS is written into a style element in the iframe head.
- JavaScript is written into a module script.
- TypeScript is transpiled, then written into a module script.
- Python remains editable, recordable, and replayable, but does not execute.

If both JavaScript and TypeScript contain content, only the most recently
selected script language is executed. Switching to HTML, CSS, or Python does not
change the selected script language.

## Data Model

Introduce a multi-document editor state for recorder and replay logic:

```ts
type RecordingDocumentLanguage =
  | "javascript"
  | "typescript"
  | "python"
  | "html"
  | "css";

type RecordingDocumentState = {
  code: string;
  cursor: ReplayStableState["editor"]["cursor"];
  selection: ReplayStableState["editor"]["selection"];
  scrollTop: number;
  scrollLeft: number;
};

type RecordingEditorState = {
  activeLanguage: RecordingDocumentLanguage;
  activeScriptLanguage: "javascript" | "typescript";
  documents: Record<RecordingDocumentLanguage, RecordingDocumentState>;
  fontSize: number;
  theme: RecordingTheme;
};
```

The existing single-document fields can remain as a compatibility projection
while the package format is migrated, but the replay source of truth should be
the per-language document map once events are updated.

## Recording Flow

Before a language switch, the recorder saves the current Monaco value and view
state into the current language's document state. It then loads the target
language's stored state into the same Monaco editor instance and updates the
Monaco model language.

Content changes are emitted for the active language only. Language changes
record the active language transition; switching to JavaScript or TypeScript
also updates `activeScriptLanguage`.

Before a run, the recorder flushes pending content for the active language, then
passes the complete document map and `activeScriptLanguage` to the runtime
producer.

## Runtime Flow

The runtime producer builds a single preview document:

```html
<!doctype html>
<html>
  <head>
    <style>/* user CSS */</style>
  </head>
  <body>
    <!-- user HTML -->
    <script type="module">
      // user JavaScript or transpiled TypeScript
    </script>
  </body>
</html>
```

The implementation must avoid raw string interpolation for style and script
contents where escaping matters. At minimum, it must prevent `</style>` and
`</script>` from breaking out of their containers. A DOM-based assembly path is
preferred when practical.

Runtime output remains persisted as `run-output.previewHtml`. Replay continues
to restore the historical iframe snapshot rather than re-running user code.

## Replay Flow

The replay reducer maintains all language document states and active language.
The visible editor renders `documents[activeLanguage]`. Runtime preview restores
the persisted `previewHtml` from run events.

Seeking must restore:

- active language
- active script language
- each language's last known code
- the active language's cursor, selection, and scroll state
- runtime output and preview snapshot

## Compatibility And Documentation

`docs/PRD.md` already requires frontend execution for JS/TS/CSS/HTML. Parts of
`docs/技术方案.md` still describe the runtime and event payloads as JS/TS-only or
JS/TS/Python-only. Before implementation changes are merged, the technical
solution must be updated or the discrepancy must be raised through the
repository discussion process required by `AGENTS.md`.

## Test Plan

- Unit test language switching preserves separate content and view state.
- Unit test content events include the active document language.
- Unit test JavaScript and TypeScript selection updates `activeScriptLanguage`.
- Unit test runtime assembly maps HTML to body, CSS to style, and JS/TS to module
  script.
- Unit test Python remains non-executable.
- Replay reducer tests cover seeking across content changes and language
  changes.
- Recorder page integration test covers JS to HTML back to JS restoration.

## Open Decisions

There are no open product decisions from this design. The confirmed behavior is
that language kinds, switching entry, and switching method remain unchanged.
