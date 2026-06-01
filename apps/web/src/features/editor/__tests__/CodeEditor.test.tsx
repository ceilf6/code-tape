import { act, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeEditorHandle } from "../CodeEditor";

type MockKeyboardEvent = {
  browserEvent: { key: string; code: string; isComposing: boolean; repeat: boolean };
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
};

const monacoMock = vi.hoisted(() => {
  class MockEditorWorker {}
  class MockTsWorker {}

  class MockModel {
    disposed = false;

    constructor(
      public value: string,
      public language: string,
    ) {}

    getValue() {
      return this.value;
    }

    getLanguageId() {
      return this.language;
    }

    getFullModelRange() {
      const lines = this.value.split("\n");
      const lastLine = lines[lines.length - 1] ?? "";
      return {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: lines.length,
        endColumn: lastLine.length + 1,
      };
    }

    setValue(next: string) {
      this.value = next;
    }

    dispose() {
      this.disposed = true;
    }
  }

  class MockEditor {
    disposed = false;
    commands: Array<{ keybinding: number; handler: () => void }> = [];
    keyboardListeners: Array<(event: MockKeyboardEvent) => void> = [];
    contentChangeListeners: Array<() => void> = [];
    updateOptions = vi.fn((nextOptions: Record<string, unknown>) => {
      Object.assign(this.options, nextOptions);
    });
    setValue = vi.fn((next: string) => {
      this.options.model.setValue(next);
    });
    setPosition = vi.fn();
    selection = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    };
    setSelection = vi.fn((next: typeof this.selection) => {
      this.selection = next;
    });
    deltaDecorations = vi.fn((_oldDecorations: string[], newDecorations: unknown[]) =>
      newDecorations.map((_decoration, index) => `decoration-${index + 1}`),
    );
    setScrollTop = vi.fn();
    setScrollLeft = vi.fn();
    trigger = vi.fn();
    getAction = vi.fn(() => null as { run(): Promise<void> | void } | null);
    pushUndoStop = vi.fn(() => true);
    executeEdits = vi.fn((_source: string, edits: Array<{ text: string }>) => {
      const [edit] = edits;
      if (edit) this.options.model.setValue(edit.text);
      return true;
    });
    addCommand = vi.fn((keybinding: number, handler: () => void) => {
      this.commands.push({ keybinding, handler });
      return `command-${this.commands.length}`;
    });
    onKeyDown = vi.fn((listener: (event: MockKeyboardEvent) => void) => {
      this.keyboardListeners.push(listener);
      return {
        dispose: () => {
          this.keyboardListeners = this.keyboardListeners.filter((candidate) => candidate !== listener);
        },
      };
    });
    onDidChangeModelContent = vi.fn((listener: () => void) => {
      this.contentChangeListeners.push(listener);
      return {
        dispose: () => {
          this.contentChangeListeners = this.contentChangeListeners.filter((candidate) => candidate !== listener);
        },
      };
    });

    constructor(
      public host: HTMLElement,
      public options: Record<string, unknown> & { model: MockModel },
    ) {}

    getValue() {
      return this.options.model.getValue();
    }

    getModel() {
      return this.options.model;
    }

    getSelection() {
      return this.selection;
    }

    dispose() {
      this.disposed = true;
    }

    emitContentChange() {
      this.contentChangeListeners.forEach((listener) => listener());
    }
  }

  const models: MockModel[] = [];
  const editors: MockEditor[] = [];
  const createModel = vi.fn((value: string, language: string) => {
    const model = new MockModel(value, language);
    models.push(model);
    return model;
  });
  const create = vi.fn((host: HTMLElement, options: Record<string, unknown> & { model: MockModel }) => {
    const editor = new MockEditor(host, options);
    editors.push(editor);
    return editor;
  });
  const defineTheme = vi.fn(() => {
    if (monacoMock.failDefineThemeCalls > 0) {
      monacoMock.failDefineThemeCalls -= 1;
      throw new Error("define theme failed");
    }
  });
  const setTheme = vi.fn();
  const setModelLanguage = vi.fn((model: MockModel, language: string) => {
    model.language = language;
  });

  return {
    MockEditorWorker,
    MockTsWorker,
    failEditorWorkerImports: 0,
    failDefineThemeCalls: 0,
    models,
    editors,
    editor: {
      create,
      createModel,
      defineTheme,
      setTheme,
      setModelLanguage,
    },
    KeyMod: {
      CtrlCmd: 1 << 11,
      Shift: 1 << 10,
      Alt: 1 << 9,
    },
    KeyCode: {
      Enter: 3,
      Slash: 85,
      KeyF: 36,
      KeyG: 37,
    },
  };
});

const prettierMock = vi.hoisted(() => ({
  format: vi.fn(async (source: string, options: { parser?: string }) => {
    if (source === "function demo(){\n\t\treturn 1;\n}" && options.parser === "babel") {
      return "function demo() {\n  return 1;\n}\n";
    }
    if (source === "const value:number=1;" && options.parser === "typescript") {
      return "const value: number = 1;\n";
    }
    return source;
  }),
}));

vi.mock("monaco-editor/esm/vs/editor/editor.api", () => ({
  editor: monacoMock.editor,
  KeyMod: monacoMock.KeyMod,
  KeyCode: monacoMock.KeyCode,
}));
vi.mock("monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution", () => ({}));
vi.mock("monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution", () => ({}));
vi.mock("monaco-editor/esm/vs/basic-languages/python/python.contribution", () => ({}));
vi.mock("monaco-editor/esm/vs/basic-languages/html/html.contribution", () => ({}));
vi.mock("monaco-editor/esm/vs/basic-languages/css/css.contribution", () => ({}));
vi.mock("monaco-editor/esm/vs/editor/contrib/comment/browser/comment", () => ({}));
vi.mock("monaco-editor/esm/vs/editor/contrib/format/browser/formatActions", () => ({}));
vi.mock("monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess", () => ({}));
vi.mock("monaco-editor/esm/vs/language/typescript/monaco.contribution", () => ({}));
vi.mock("monaco-editor/esm/vs/editor/editor.worker?worker", () => ({
  get default() {
    if (monacoMock.failEditorWorkerImports > 0) {
      monacoMock.failEditorWorkerImports -= 1;
      throw new Error("editor worker import failed");
    }
    return monacoMock.MockEditorWorker;
  },
}));
vi.mock("monaco-editor/esm/vs/language/typescript/ts.worker?worker", () => ({
  default: monacoMock.MockTsWorker,
}));
vi.mock("prettier/standalone", () => ({
  format: prettierMock.format,
}));
vi.mock("prettier/plugins/babel", () => ({}));
vi.mock("prettier/plugins/estree", () => ({}));
vi.mock("prettier/plugins/typescript", () => ({}));

describe("CodeEditor", () => {
  beforeEach(() => {
    vi.resetModules();
    monacoMock.models.length = 0;
    monacoMock.editors.length = 0;
    monacoMock.failEditorWorkerImports = 0;
    monacoMock.failDefineThemeCalls = 0;
    monacoMock.editor.create.mockClear();
    monacoMock.editor.createModel.mockClear();
    monacoMock.editor.defineTheme.mockClear();
    monacoMock.editor.setTheme.mockClear();
    monacoMock.editor.setModelLanguage.mockClear();
    prettierMock.format.mockClear();
    delete (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function pressEditorShortcut(
    editor: { keyboardListeners: Array<(event: MockKeyboardEvent) => void> },
    event: Partial<MockKeyboardEvent> & { key: string },
  ) {
    const keyboardEvent: MockKeyboardEvent = {
      browserEvent: {
        key: event.key,
        code: event.browserEvent?.code ?? event.code ?? (event.key.length === 1 ? `Key${event.key.toUpperCase()}` : event.key),
        isComposing: false,
        repeat: false,
      },
      code: event.code ?? (event.key.length === 1 ? `Key${event.key.toUpperCase()}` : event.key),
      ctrlKey: event.ctrlKey ?? false,
      metaKey: event.metaKey ?? false,
      shiftKey: event.shiftKey ?? false,
      altKey: event.altKey ?? false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    editor.keyboardListeners.forEach((listener) => listener(keyboardEvent));
    return keyboardEvent;
  }

  it("lazy-loads Monaco, creates the editor with initial props, and exposes it", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const ref = createRef<CodeEditorHandle>();
    const onMount = vi.fn();

    render(
      <CodeEditor
        ref={ref}
        language="javascript"
        initialValue="const answer = 42;"
        fontSize={16}
        theme="dark"
        onMount={onMount}
      />,
    );

    expect(monacoMock.editor.create).not.toHaveBeenCalled();
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));

    expect(monacoMock.editor.createModel).toHaveBeenCalledWith("const answer = 42;", "javascript");
    expect(monacoMock.editors[0].options).toEqual(
      expect.objectContaining({
        automaticLayout: true,
        fontSize: 16,
        model: monacoMock.models[0],
        theme: "code-tape-dark",
      }),
    );
    expect(ref.current?.getEditor()).toBe(monacoMock.editors[0]);
    expect(onMount).toHaveBeenCalledWith(monacoMock.editors[0]);
  });

  it("notifies when Monaco model content changes", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const onChange = vi.fn();
    const nextOnChange = vi.fn();
    const { rerender } = render(
      <CodeEditor
        language="javascript"
        initialValue="console.log('first');"
        fontSize={14}
        theme="dark"
        onChange={onChange}
      />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const editor = monacoMock.editors[0];

    editor.emitContentChange();
    expect(onChange).toHaveBeenCalledTimes(1);

    rerender(
      <CodeEditor
        language="javascript"
        initialValue="console.log('first');"
        fontSize={14}
        theme="dark"
        onChange={nextOnChange}
      />,
    );
    editor.emitContentChange();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(nextOnChange).toHaveBeenCalledTimes(1);
  });

  it("updates language, font size, and theme without rewriting initialValue", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const { rerender } = render(
      <CodeEditor language="javascript" initialValue="const first = true;" fontSize={14} theme="dark" />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const model = monacoMock.models[0];
    const editor = monacoMock.editors[0];
    model.value = "const userTyped = true;";

    await act(async () => {
      rerender(
        <CodeEditor
          language="typescript"
          initialValue="const overwritten = true;"
          fontSize={18}
          theme="light"
        />,
      );
    });

    expect(model.getValue()).toBe("const userTyped = true;");
    expect(monacoMock.editor.setModelLanguage).toHaveBeenCalledWith(model, "typescript");
    expect(editor.updateOptions).toHaveBeenCalledWith({ fontSize: 18 });
    expect(monacoMock.editor.setTheme).toHaveBeenCalledWith("code-tape-light");
  });

  it("applies controlled replay state without changing initialValue semantics", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const { rerender } = render(
      <CodeEditor
        language="javascript"
        initialValue="const first = true;"
        value="const replay = 1;"
        fontSize={14}
        theme="dark"
        readOnly
        cursor={{ lineNumber: 2, column: 3 }}
        selection={null}
        scrollTop={120}
        scrollLeft={8}
      />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const editor = monacoMock.editors[0];

    expect(editor.getValue()).toBe("const replay = 1;");
    expect(editor.options.readOnly).toBe(true);
    expect(editor.setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 3 });
    expect(editor.setScrollTop).toHaveBeenCalledWith(120);
    expect(editor.setScrollLeft).toHaveBeenCalledWith(8);

    await act(async () => {
      rerender(
        <CodeEditor
          language="javascript"
          initialValue="const ignored = true;"
          value="const replay = 2;"
          fontSize={14}
          theme="dark"
          readOnly={false}
          cursor={null}
          selection={{
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 5,
          }}
          scrollTop={240}
          scrollLeft={16}
        />,
      );
    });

    expect(editor.getValue()).toBe("const replay = 2;");
    expect(editor.setValue).toHaveBeenCalledWith("const replay = 2;");
    expect(editor.updateOptions).toHaveBeenCalledWith({ readOnly: false });
    expect(editor.setSelection).toHaveBeenCalledWith({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 5,
    });
    expect(editor.setScrollTop).toHaveBeenCalledWith(240);
    expect(editor.setScrollLeft).toHaveBeenCalledWith(16);
  });

  it("adds a temporary pulse decoration for collapsed replay selections", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    render(
      <CodeEditor
        language="javascript"
        initialValue="const replay = true;\nconsole.log(replay);"
        value="const replay = true;\nconsole.log(replay);"
        fontSize={14}
        theme="dark"
        readOnly
        cursor={{ lineNumber: 2, column: 8 }}
        selection={{
          startLineNumber: 2,
          startColumn: 8,
          endLineNumber: 2,
          endColumn: 8,
        }}
      />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const editor = monacoMock.editors[0];

    expect(editor.deltaDecorations).toHaveBeenCalledWith(
      [],
      [
        expect.objectContaining({
          range: {
            startLineNumber: 2,
            startColumn: 8,
            endLineNumber: 2,
            endColumn: 8,
          },
          options: expect.objectContaining({
            beforeContentClassName: "code-tape-collapsed-selection-pulse",
          }),
        }),
      ],
    );
  });

  it("registers common editor shortcut commands", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const onCommand = vi.fn();
    render(
      <CodeEditor
        language="javascript"
        initialValue="console.log('shortcuts');"
        fontSize={14}
        theme="dark"
        onCommand={onCommand}
      />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const editor = monacoMock.editors[0];

    const runEvent = pressEditorShortcut(editor, { key: "Enter", ctrlKey: true });
    pressEditorShortcut(editor, { key: "s", metaKey: true });
    pressEditorShortcut(editor, { key: "f", shiftKey: true, altKey: true });
    pressEditorShortcut(editor, { key: "/", code: "Slash", metaKey: true });
    pressEditorShortcut(editor, { key: "g", metaKey: true });

    expect(onCommand).toHaveBeenCalledWith("run");
    expect(editor.trigger).toHaveBeenCalledWith("keyboard", "editor.action.formatDocument", null);
    expect(onCommand).toHaveBeenCalledWith("format");
    expect(editor.trigger).toHaveBeenCalledWith("keyboard", "editor.action.commentLine", null);
    expect(editor.trigger).toHaveBeenCalledWith("keyboard", "editor.action.gotoLine", null);
    expect(runEvent.preventDefault).toHaveBeenCalled();
    expect(runEvent.stopPropagation).toHaveBeenCalled();
  });

  it("formats from an Option-modified physical F key", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    render(
      <CodeEditor
        language="javascript"
        initialValue="function demo(){return 1;}"
        fontSize={14}
        theme="dark"
      />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const editor = monacoMock.editors[0];

    pressEditorShortcut(editor, {
      key: "ƒ",
      code: "",
      browserEvent: { code: "KeyF", key: "ƒ", isComposing: false, repeat: false },
      shiftKey: true,
      altKey: true,
    });

    expect(editor.trigger).toHaveBeenCalledWith("keyboard", "editor.action.formatDocument", null);
  });

  it("formats from the primary format shortcut", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const onCommand = vi.fn();
    render(
      <CodeEditor
        language="javascript"
        initialValue="function demo(){return 1;}"
        fontSize={14}
        theme="dark"
        onCommand={onCommand}
      />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const editor = monacoMock.editors[0];

    const event = pressEditorShortcut(editor, { key: "s", metaKey: true });

    expect(editor.trigger).toHaveBeenCalledWith("keyboard", "editor.action.formatDocument", null);
    expect(onCommand).toHaveBeenCalledWith("format");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });

  it("uses a JS formatter fallback when Monaco format action leaves the document unchanged", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    render(
      <CodeEditor
        language="javascript"
        initialValue={"function demo(){\n\t\treturn 1;\n}"}
        fontSize={14}
        theme="dark"
      />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const editor = monacoMock.editors[0];
    const originalRange = monacoMock.models[0].getFullModelRange();
    const originalSelection = {
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 2,
      endColumn: 9,
    };
    editor.selection = originalSelection;

    pressEditorShortcut(editor, { key: "f", shiftKey: true, altKey: true });

    await waitFor(() => expect(editor.getValue()).toBe("function demo() {\n  return 1;\n}\n"));
    expect(editor.setValue).not.toHaveBeenCalled();
    expect(editor.executeEdits).toHaveBeenCalledWith(
      "code-tape-format",
      [
        expect.objectContaining({
          range: originalRange,
          text: "function demo() {\n  return 1;\n}\n",
        }),
      ],
      [originalSelection],
    );
    expect(editor.pushUndoStop).toHaveBeenCalledTimes(2);
    expect(prettierMock.format).toHaveBeenCalledWith(
      "function demo(){\n\t\treturn 1;\n}",
      expect.objectContaining({ parser: "babel", tabWidth: 2, useTabs: false }),
    );
  });

  it("uses the formatter fallback when the Monaco format action rejects", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <CodeEditor
        language="javascript"
        initialValue={"function demo(){\n\t\treturn 1;\n}"}
        fontSize={14}
        theme="dark"
      />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const editor = monacoMock.editors[0];
    const actionError = new Error("format action failed");
    editor.getAction.mockReturnValueOnce({
      run: vi.fn(async () => {
        throw actionError;
      }),
    });

    pressEditorShortcut(editor, { key: "f", shiftKey: true, altKey: true });

    await waitFor(() => expect(editor.getValue()).toBe("function demo() {\n  return 1;\n}\n"));
    expect(consoleWarn).toHaveBeenCalledWith("Monaco format action failed", actionError);
    consoleWarn.mockRestore();
  });

  it("uses a TypeScript formatter fallback when Monaco format action leaves the document unchanged", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    render(
      <CodeEditor
        language="typescript"
        initialValue="const value:number=1;"
        fontSize={14}
        theme="dark"
      />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const editor = monacoMock.editors[0];

    pressEditorShortcut(editor, { key: "f", shiftKey: true, altKey: true });

    await waitFor(() => expect(editor.getValue()).toBe("const value: number = 1;\n"));
    expect(prettierMock.format).toHaveBeenCalledWith(
      "const value:number=1;",
      expect.objectContaining({ parser: "typescript", tabWidth: 2, useTabs: false }),
    );
  });

  it("does not overwrite edits made while the formatter fallback is pending", async () => {
    let resolveFormat: (formatted: string) => void = () => {
      throw new Error("format promise was not created");
    };
    prettierMock.format.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFormat = resolve;
        }),
    );
    const { CodeEditor } = await import("../CodeEditor");
    render(
      <CodeEditor
        language="javascript"
        initialValue={"function demo(){\n\t\treturn 1;\n}"}
        fontSize={14}
        theme="dark"
      />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const editor = monacoMock.editors[0];

    pressEditorShortcut(editor, { key: "f", shiftKey: true, altKey: true });
    await waitFor(() => expect(prettierMock.format).toHaveBeenCalledTimes(1));

    monacoMock.models[0].setValue("const userKeptTyping = true;");
    await act(async () => {
      resolveFormat("function demo() {\n  return 1;\n}\n");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(editor.getValue()).toBe("const userKeptTyping = true;");
    expect(editor.executeEdits).not.toHaveBeenCalled();
    expect(editor.setValue).not.toHaveBeenCalled();
  });

  it("does not apply pending formatter fallback after the editor becomes read-only", async () => {
    let resolveFormat: (formatted: string) => void = () => {
      throw new Error("format promise was not created");
    };
    prettierMock.format.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFormat = resolve;
        }),
    );
    const { CodeEditor } = await import("../CodeEditor");
    const onBeforeFormatApply = vi.fn();
    const { rerender } = render(
      <CodeEditor
        language="javascript"
        initialValue={"function demo(){\n\t\treturn 1;\n}"}
        fontSize={14}
        theme="dark"
        onBeforeFormatApply={onBeforeFormatApply}
      />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const editor = monacoMock.editors[0];

    pressEditorShortcut(editor, { key: "f", shiftKey: true, altKey: true });
    await waitFor(() => expect(prettierMock.format).toHaveBeenCalledTimes(1));

    rerender(
      <CodeEditor
        language="javascript"
        initialValue={"function demo(){\n\t\treturn 1;\n}"}
        fontSize={14}
        theme="dark"
        readOnly
        onBeforeFormatApply={onBeforeFormatApply}
      />,
    );
    await act(async () => {
      resolveFormat("function demo() {\n  return 1;\n}\n");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(editor.getValue()).toBe("function demo(){\n\t\treturn 1;\n}");
    expect(editor.executeEdits).not.toHaveBeenCalled();
    expect(onBeforeFormatApply).not.toHaveBeenCalled();
  });

  it("does not apply pending formatter fallback after the editor language changes", async () => {
    let resolveFormat: (formatted: string) => void = () => {
      throw new Error("format promise was not created");
    };
    prettierMock.format.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFormat = resolve;
        }),
    );
    const { CodeEditor } = await import("../CodeEditor");
    const onBeforeFormatApply = vi.fn();
    const { rerender } = render(
      <CodeEditor
        language="typescript"
        initialValue="const value:number=1;"
        fontSize={14}
        theme="dark"
        onBeforeFormatApply={onBeforeFormatApply}
      />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const editor = monacoMock.editors[0];

    pressEditorShortcut(editor, { key: "f", shiftKey: true, altKey: true });
    await waitFor(() => expect(prettierMock.format).toHaveBeenCalledTimes(1));

    rerender(
      <CodeEditor
        language="javascript"
        initialValue="const value:number=1;"
        fontSize={14}
        theme="dark"
        onBeforeFormatApply={onBeforeFormatApply}
      />,
    );
    await waitFor(() => expect(monacoMock.editor.setModelLanguage).toHaveBeenCalledWith(monacoMock.models[0], "javascript"));
    await act(async () => {
      resolveFormat("const value: number = 1;\n");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(editor.getValue()).toBe("const value:number=1;");
    expect(editor.executeEdits).not.toHaveBeenCalled();
    expect(onBeforeFormatApply).not.toHaveBeenCalled();
  });

  it("does not run formatter fallback for read-only replay editors", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    render(
      <CodeEditor
        language="javascript"
        initialValue={"function demo(){\n\t\treturn 1;\n}"}
        fontSize={14}
        theme="dark"
        readOnly
      />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const editor = monacoMock.editors[0];

    pressEditorShortcut(editor, { key: "f", shiftKey: true, altKey: true });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(editor.getValue()).toBe("function demo(){\n\t\treturn 1;\n}");
    expect(prettierMock.format).not.toHaveBeenCalled();
  });

  it("configures JS/TS workers and disposes editor resources on unmount", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const { unmount } = render(
      <CodeEditor language="typescript" initialValue="let value: number = 1;" fontSize={14} theme="dark" />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));

    const environment = (globalThis as {
      MonacoEnvironment?: { getWorker(workerId: string, label: string): Worker };
    }).MonacoEnvironment;
    expect(environment?.getWorker("", "javascript")).toBeInstanceOf(monacoMock.MockTsWorker);
    expect(environment?.getWorker("", "typescript")).toBeInstanceOf(monacoMock.MockTsWorker);
    expect(environment?.getWorker("", "editorWorkerService")).toBeInstanceOf(
      monacoMock.MockEditorWorker,
    );

    unmount();

    expect(monacoMock.editors[0].disposed).toBe(true);
    expect(monacoMock.models[0].disposed).toBe(true);
  });

  it("does not rewrite MonacoEnvironment after workers are configured", async () => {
    const { CodeEditor } = await import("../CodeEditor");
    const first = render(
      <CodeEditor language="javascript" initialValue="const first = 1;" fontSize={14} theme="dark" />,
    );
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));
    const environment = (globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment;
    first.unmount();

    render(<CodeEditor language="typescript" initialValue="const second = 2;" fontSize={14} theme="light" />);
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(2));

    expect((globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment).toBe(environment);
  });

  it("shows a load error and retries after a Monaco initialization failure", async () => {
    monacoMock.failDefineThemeCalls = 1;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { CodeEditor } = await import("../CodeEditor");
    const first = render(
      <CodeEditor language="javascript" initialValue="const first = 1;" fontSize={14} theme="dark" />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Code editor failed to load.");
    expect(monacoMock.editor.create).not.toHaveBeenCalled();
    first.unmount();

    render(<CodeEditor language="javascript" initialValue="const retry = 1;" fontSize={14} theme="dark" />);
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(consoleError).toHaveBeenCalledWith("Failed to initialize Monaco editor", expect.any(Error));
    consoleError.mockRestore();
  });

  it("retries after a worker import failure", async () => {
    monacoMock.failEditorWorkerImports = 1;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { CodeEditor } = await import("../CodeEditor");
    const first = render(
      <CodeEditor language="typescript" initialValue="const first = 1;" fontSize={14} theme="dark" />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Code editor failed to load.");
    first.unmount();

    render(<CodeEditor language="typescript" initialValue="const retry = 1;" fontSize={14} theme="dark" />);
    await waitFor(() => expect(monacoMock.editor.create).toHaveBeenCalledTimes(1));

    expect(consoleError).toHaveBeenCalledWith("Failed to initialize Monaco editor", expect.any(Error));
    consoleError.mockRestore();
  });
});
