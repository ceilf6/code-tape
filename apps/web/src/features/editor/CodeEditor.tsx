import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import type { RecordingLanguage, ReplayStableState } from "@/shared/recording-schema";

export type CodeEditorHandle = {
  /** Lazy accessor — null until the editor has mounted. */
  getEditor(): Monaco.editor.IStandaloneCodeEditor | null;
  setModelLanguage(language: RecordingLanguage): void;
};

export type CodeEditorCommand = "run" | "format" | "comment" | "go-to-line";

export type CodeEditorProps = {
  language: RecordingLanguage;
  initialValue: string;
  value?: string;
  fontSize: number;
  theme: "light" | "dark";
  readOnly?: boolean;
  cursor?: ReplayStableState["editor"]["cursor"];
  selection?: ReplayStableState["editor"]["selection"];
  scrollTop?: number;
  scrollLeft?: number;
  minHeight?: "default" | "compact";
  onMount?(editor: Monaco.editor.IStandaloneCodeEditor): void;
  onChange?(): void;
  onCommand?(command: CodeEditorCommand): void;
  onBeforeFormatApply?(): (() => void) | void;
};

type MonacoModule = typeof Monaco;
type MonacoTheme = "code-tape-light" | "code-tape-dark";
type WorkerConstructor = new () => Worker;
type WorkerConstructors = {
  editor: WorkerConstructor;
  typescript: WorkerConstructor;
};
type MonacoEnvironmentHost = typeof globalThis & {
  MonacoEnvironment?: {
    getWorker(workerId: string, label: string): Worker;
  };
};

let workerPromise: Promise<WorkerConstructors> | null = null;
let monacoPromise: Promise<MonacoModule> | null = null;
let prettierFormatterPromise: Promise<PrettierFormatter> | null = null;
let themesDefined = false;
let workersConfigured = false;
const COLLAPSED_SELECTION_PULSE_MS = 420;
const FORMAT_ACTION_ID = "editor.action.formatDocument";

type PrettierFormatter = {
  format(source: string, language: RecordingLanguage): Promise<string | null>;
};

function monacoTheme(theme: CodeEditorProps["theme"]): MonacoTheme {
  return theme === "dark" ? "code-tape-dark" : "code-tape-light";
}

function loadWorkers() {
  workerPromise ??= Promise.all([
    import("monaco-editor/esm/vs/editor/editor.worker?worker"),
    import("monaco-editor/esm/vs/language/typescript/ts.worker?worker"),
  ])
    .then(([editorWorker, tsWorker]) => ({
      editor: editorWorker.default,
      typescript: tsWorker.default,
    }))
    .catch((error: unknown) => {
      workerPromise = null;
      throw error;
    });
  return workerPromise;
}

function configureWorkers(workers: WorkerConstructors) {
  if (workersConfigured) return;
  (globalThis as MonacoEnvironmentHost).MonacoEnvironment = {
    getWorker(_workerId, label) {
      if (label === "javascript" || label === "typescript") {
        return new workers.typescript();
      }
      return new workers.editor();
    },
  };
  workersConfigured = true;
}

function defineThemes(monaco: MonacoModule) {
  if (themesDefined) return;
  monaco.editor.defineTheme("code-tape-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#f5f5f4",
      "editor.foreground": "#24272d",
      "editorLineNumber.foreground": "#7b808a",
      "editorLineNumber.activeForeground": "#2f66c9",
      "editorCursor.foreground": "#2f66c9",
      "editor.selectionBackground": "#b8d6ff",
      "editor.inactiveSelectionBackground": "#d7e6fb",
      "editor.lineHighlightBackground": "#ffffff",
      "editorGutter.background": "#f5f5f4",
    },
  });
  monaco.editor.defineTheme("code-tape-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#252931",
      "editor.foreground": "#e8eaee",
      "editorLineNumber.foreground": "#9ba2ad",
      "editorLineNumber.activeForeground": "#8fc4ff",
      "editorCursor.foreground": "#8fc4ff",
      "editor.selectionBackground": "#284b74",
      "editor.inactiveSelectionBackground": "#334153",
      "editor.lineHighlightBackground": "#2d323b",
      "editorGutter.background": "#252931",
    },
  });
  themesDefined = true;
}

async function loadMonaco() {
  const workers = await loadWorkers();
  configureWorkers(workers);
  monacoPromise ??= (async () => {
    const monaco = await import("monaco-editor/esm/vs/editor/editor.api");
    await Promise.all([
      import("monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution"),
      import("monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution"),
      import("monaco-editor/esm/vs/basic-languages/python/python.contribution"),
      import("monaco-editor/esm/vs/basic-languages/html/html.contribution"),
      import("monaco-editor/esm/vs/basic-languages/css/css.contribution"),
      import("monaco-editor/esm/vs/editor/contrib/comment/browser/comment"),
      import("monaco-editor/esm/vs/editor/contrib/format/browser/formatActions"),
      import("monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess"),
      import("monaco-editor/esm/vs/language/typescript/monaco.contribution"),
    ]);
    defineThemes(monaco);
    return monaco;
  })().catch((error: unknown) => {
    monacoPromise = null;
    throw error;
  });
  return monacoPromise;
}

export const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  {
    language,
    initialValue,
    value,
    fontSize,
    theme,
    readOnly = false,
    cursor,
    selection,
    scrollTop,
    scrollLeft,
    minHeight = "default",
    onMount,
    onChange,
    onCommand,
    onBeforeFormatApply,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelRef = useRef<Monaco.editor.ITextModel | null>(null);
  const monacoRef = useRef<MonacoModule | null>(null);
  const collapsedSelectionDecorationIdsRef = useRef<string[]>([]);
  const collapsedSelectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialValueRef = useRef(initialValue);
  const latestPropsRef = useRef({
    language,
    value,
    fontSize,
    theme,
    readOnly,
    cursor,
    selection,
    scrollTop,
    scrollLeft,
  });
  const onMountRef = useRef(onMount);
  const onChangeRef = useRef(onChange);
  const onCommandRef = useRef(onCommand);
  const onBeforeFormatApplyRef = useRef(onBeforeFormatApply);
  const [loadError, setLoadError] = useState<unknown>(null);
  const minHeightClass = minHeight === "compact" ? "min-h-[288px]" : "min-h-[320px]";

  latestPropsRef.current = {
    language,
    value,
    fontSize,
    theme,
    readOnly,
    cursor,
    selection,
    scrollTop,
    scrollLeft,
  };
  onMountRef.current = onMount;
  onChangeRef.current = onChange;
  onCommandRef.current = onCommand;
  onBeforeFormatApplyRef.current = onBeforeFormatApply;

  useImperativeHandle(
    ref,
    () => ({
      getEditor: () => editorRef.current,
      setModelLanguage: (nextLanguage) => {
        const monaco = monacoRef.current;
        const model = modelRef.current;
        if (!monaco || !model) return;
        monaco.editor.setModelLanguage(model, nextLanguage);
      },
    }),
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return undefined;

    void loadMonaco()
      .then((monaco) => {
        if (cancelled) return;
        setLoadError(null);
        const currentProps = latestPropsRef.current;
        const model = monaco.editor.createModel(initialValueRef.current, currentProps.language);
        const editor = monaco.editor.create(host, {
          model,
          automaticLayout: true,
          fontSize: currentProps.fontSize,
          minimap: { enabled: false },
          readOnly: currentProps.readOnly,
          scrollBeyondLastLine: false,
          tabSize: 2,
          theme: monacoTheme(currentProps.theme),
        });

        monacoRef.current = monaco;
        modelRef.current = model;
        editorRef.current = editor;
        const contentChangeDisposable = editor.onDidChangeModelContent(() => {
          onChangeRef.current?.();
        });
        registerEditorCommands(
          monaco,
          editor,
          () => latestPropsRef.current.readOnly,
          (command) => onCommandRef.current?.(command),
          () => onBeforeFormatApplyRef.current?.(),
        );
        applyControlledEditorState(editor, currentProps);
        pulseCollapsedSelection(editor, currentProps.selection, collapsedSelectionDecorationIdsRef, collapsedSelectionTimerRef);
        onMountRef.current?.(editor);
        editor.onDidDispose?.(() => contentChangeDisposable.dispose());
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error);
          console.error("Failed to initialize Monaco editor", error);
        }
      });

    return () => {
      cancelled = true;
      const editor = editorRef.current;
      const model = modelRef.current;
      clearCollapsedSelectionPulse(editor, collapsedSelectionDecorationIdsRef, collapsedSelectionTimerRef);
      editorRef.current = null;
      modelRef.current = null;
      monacoRef.current = null;
      editor?.dispose();
      model?.dispose();
    };
  }, []);

  useEffect(() => {
    const monaco = monacoRef.current;
    const model = modelRef.current;
    if (!monaco || !model) return;
    monaco.editor.setModelLanguage(model, language);
  }, [language]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize });
  }, [fontSize]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    monacoRef.current?.editor.setTheme(monacoTheme(theme));
  }, [theme]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || value === undefined || editor.getValue() === value) return;
    editor.setValue(value);
  }, [value]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (selection) {
      editor.setSelection(selection);
    } else if (cursor) {
      editor.setPosition(cursor);
    }
    pulseCollapsedSelection(editor, selection, collapsedSelectionDecorationIdsRef, collapsedSelectionTimerRef);
  }, [cursor, selection]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || scrollTop === undefined) return;
    editor.setScrollTop(scrollTop);
  }, [scrollTop]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || scrollLeft === undefined) return;
    editor.setScrollLeft(scrollLeft);
  }, [scrollLeft]);

  return (
    <div className={`relative h-full ${minHeightClass} w-full bg-surface`} data-code-editor>
      <div ref={hostRef} aria-label="Code editor" className={`h-full ${minHeightClass} w-full`} />
      {loadError ? (
        <div className="absolute inset-0 flex items-center justify-center bg-surface/90 p-4" role="alert">
          <div className="max-w-sm rounded-md border border-border bg-surface-raised px-4 py-3 shadow-elevation-2">
            <p className="text-sm font-medium text-foreground">Code editor failed to load.</p>
            <p className="mt-1 text-xs text-muted">Refresh the page or reopen this view to retry.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
});

function registerEditorCommands(
  _monaco: MonacoModule,
  editor: Monaco.editor.IStandaloneCodeEditor,
  isReadOnly: () => boolean,
  onCommand: (command: CodeEditorCommand) => void,
  onBeforeFormatApply: () => (() => void) | void,
) {
  editor.onKeyDown((event) => {
    const browserEvent = event.browserEvent;
    if (browserEvent.isComposing || browserEvent.repeat) return;

    if (isPrimaryShortcut(event, "Enter")) {
      consumeShortcut(event);
      onCommand("run");
      return;
    }

    if (isFormatShortcut(event)) {
      consumeShortcut(event);
      if (isReadOnly()) return;
      void formatEditorDocument(editor, isReadOnly, onBeforeFormatApply);
      onCommand("format");
      return;
    }

    if (isPrimaryShortcut(event, "/")) {
      consumeShortcut(event);
      editor.trigger("keyboard", "editor.action.commentLine", null);
      onCommand("comment");
      return;
    }

    if (isPrimaryShortcut(event, "g")) {
      consumeShortcut(event);
      editor.trigger("keyboard", "editor.action.gotoLine", null);
      onCommand("go-to-line");
    }
  });
}

async function formatEditorDocument(
  editor: Monaco.editor.IStandaloneCodeEditor,
  isReadOnly: () => boolean,
  onBeforeFormatApply: () => (() => void) | void,
) {
  const originalValue = editor.getValue();
  const action = typeof editor.getAction === "function" ? editor.getAction(FORMAT_ACTION_ID) : null;

  try {
    if (action) {
      await action.run();
    } else {
      editor.trigger("keyboard", FORMAT_ACTION_ID, null);
    }
  } catch (error) {
    console.warn("Monaco format action failed", error);
  }

  if (isReadOnly() || editor.getValue() !== originalValue) return;

  const model = editor.getModel();
  if (!model) return;
  const language = model.getLanguageId() as RecordingLanguage | undefined;
  if (!language || !isPrettierSupportedLanguage(language)) return;

  try {
    const formatter = await loadPrettierFormatter();
    const formatted = await formatter.format(originalValue, language);
    const currentModel = editor.getModel();
    if (
      !formatted ||
      formatted === originalValue ||
      isReadOnly() ||
      editor.getValue() !== originalValue ||
      currentModel !== model ||
      currentModel.getLanguageId() !== language
    ) {
      return;
    }
    const cancelFormatSignal = onBeforeFormatApply();
    const currentSelection = editor.getSelection();
    const endCursorState = currentSelection ? [currentSelection] : undefined;
    try {
      editor.pushUndoStop();
      const applied = editor.executeEdits(
        "code-tape-format",
        [
          {
            range: model.getFullModelRange(),
            text: formatted,
            forceMoveMarkers: true,
          },
        ],
        endCursorState,
      );
      if (!applied) {
        cancelFormatSignal?.();
        return;
      }
      editor.pushUndoStop();
    } catch (error) {
      cancelFormatSignal?.();
      throw error;
    }
  } catch (error) {
    console.warn("Failed to format editor document", error);
  }
}

function isPrettierSupportedLanguage(language: RecordingLanguage): boolean {
  return language === "javascript" || language === "typescript";
}

function loadPrettierFormatter(): Promise<PrettierFormatter> {
  prettierFormatterPromise ??= (async () => {
    const [prettier, babelPlugin, estreePlugin, typescriptPlugin] = await Promise.all([
      import("prettier/standalone"),
      import("prettier/plugins/babel"),
      import("prettier/plugins/estree"),
      import("prettier/plugins/typescript"),
    ]);
    return {
      async format(source: string, language: RecordingLanguage) {
        const parser = language === "typescript" ? "typescript" : "babel";
        return prettier.format(source, {
          parser,
          plugins: [babelPlugin, estreePlugin, typescriptPlugin],
          tabWidth: 2,
          useTabs: false,
          semi: true,
          singleQuote: false,
        });
      },
    };
  })().catch((error: unknown) => {
    prettierFormatterPromise = null;
    throw error;
  });
  return prettierFormatterPromise;
}

function isPrimaryShortcut(event: Monaco.IKeyboardEvent, key: string): boolean {
  return (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && matchesKey(event, key);
}

function isFormatShortcut(event: Monaco.IKeyboardEvent): boolean {
  return !event.metaKey && !event.ctrlKey && event.shiftKey && event.altKey && matchesKey(event, "f");
}

function matchesKey(event: Monaco.IKeyboardEvent, key: string): boolean {
  const expected = key.toLowerCase();
  const actualKey = event.browserEvent.key.toLowerCase();
  const expectedCode = `key${expected}`;
  return (
    actualKey === expected
    || event.code.toLowerCase() === expectedCode
    || event.browserEvent.code.toLowerCase() === expectedCode
  );
}

function consumeShortcut(event: Monaco.IKeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
}

function applyControlledEditorState(
  editor: Monaco.editor.IStandaloneCodeEditor,
  props: {
    value?: string;
    cursor?: ReplayStableState["editor"]["cursor"];
    selection?: ReplayStableState["editor"]["selection"];
    scrollTop?: number;
    scrollLeft?: number;
  },
) {
  if (props.value !== undefined && editor.getValue() !== props.value) {
    editor.setValue(props.value);
  }
  if (props.selection) {
    editor.setSelection(props.selection);
  } else if (props.cursor) {
    editor.setPosition(props.cursor);
  }
  if (props.scrollTop !== undefined) editor.setScrollTop(props.scrollTop);
  if (props.scrollLeft !== undefined) editor.setScrollLeft(props.scrollLeft);
}

function isCollapsedSelection(
  selection: ReplayStableState["editor"]["selection"] | undefined,
): selection is NonNullable<ReplayStableState["editor"]["selection"]> {
  return Boolean(
    selection
      && selection.startLineNumber === selection.endLineNumber
      && selection.startColumn === selection.endColumn,
  );
}

function pulseCollapsedSelection(
  editor: Monaco.editor.IStandaloneCodeEditor,
  selection: ReplayStableState["editor"]["selection"] | undefined,
  decorationIdsRef: MutableRefObject<string[]>,
  timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
) {
  clearCollapsedSelectionPulse(editor, decorationIdsRef, timerRef);
  if (!isCollapsedSelection(selection)) return;

  decorationIdsRef.current = editor.deltaDecorations(
    [],
    [
      {
        range: selection,
        options: {
          beforeContentClassName: "code-tape-collapsed-selection-pulse",
        },
      },
    ],
  );

  timerRef.current = setTimeout(() => {
    clearCollapsedSelectionPulse(editor, decorationIdsRef, timerRef);
  }, COLLAPSED_SELECTION_PULSE_MS);
}

function clearCollapsedSelectionPulse(
  editor: Monaco.editor.IStandaloneCodeEditor | null,
  decorationIdsRef: MutableRefObject<string[]>,
  timerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>,
) {
  if (timerRef.current) {
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }
  if (!editor || decorationIdsRef.current.length === 0) return;
  editor.deltaDecorations(decorationIdsRef.current, []);
  decorationIdsRef.current = [];
}
