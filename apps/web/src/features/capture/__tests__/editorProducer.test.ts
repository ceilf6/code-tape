import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "@/features/recorder/eventBus";
import { createRecordingClock } from "@/features/recorder/recordingClock";
import type { RecordingLanguage, RecordingTheme } from "@/shared/recording-schema";
import { createEditorProducer } from "../editorProducer";
import type { EditorProducerDeps } from "../types";

type Disposable = { dispose(): void };
type ContentChangeEvent = {
  changes?: Array<{ text: string; rangeLength?: number }>;
  isUndoing?: boolean;
  isRedoing?: boolean;
};
type Selection = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

class MockModel {
  constructor(
    private value: string,
    public language: RecordingLanguage,
  ) {}

  getValue() {
    return this.value;
  }

  setValue(next: string) {
    this.value = next;
  }
}

class MockEditor {
  private contentListeners = new Set<(event: ContentChangeEvent) => void>();
  private pasteListeners = new Set<() => void>();
  private selectionListeners = new Set<() => void>();
  private scrollListeners = new Set<() => void>();
  private position: { lineNumber: number; column: number } | null = { lineNumber: 1, column: 1 };
  private selection: Selection | null = {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 1,
  };
  private scroll = { scrollTop: 0, scrollLeft: 0 };

  constructor(
    private readonly model: MockModel,
    private readonly rawOptions: { fontSize: number; theme: string } = {
      fontSize: 16,
      theme: "code-tape-dark",
    },
  ) {}

  getModel() {
    return this.model;
  }

  getValue() {
    return this.model.getValue();
  }

  getPosition() {
    return this.position;
  }

  getSelection() {
    return this.selection;
  }

  getScrollTop() {
    return this.scroll.scrollTop;
  }

  getScrollLeft() {
    return this.scroll.scrollLeft;
  }

  getRawOptions() {
    return this.rawOptions;
  }

  onDidChangeModelContent(listener: (event: ContentChangeEvent) => void): Disposable {
    this.contentListeners.add(listener);
    return { dispose: () => this.contentListeners.delete(listener) };
  }

  onDidPaste(listener: () => void): Disposable {
    this.pasteListeners.add(listener);
    return { dispose: () => this.pasteListeners.delete(listener) };
  }

  onDidChangeCursorSelection(listener: () => void): Disposable {
    this.selectionListeners.add(listener);
    return { dispose: () => this.selectionListeners.delete(listener) };
  }

  onDidScrollChange(listener: () => void): Disposable {
    this.scrollListeners.add(listener);
    return { dispose: () => this.scrollListeners.delete(listener) };
  }

  changeContent(next: string, event: ContentChangeEvent = { changes: [{ text: next }] }) {
    this.model.setValue(next);
    this.contentListeners.forEach((listener) => listener(event));
  }

  pasteContent(next: string, event: ContentChangeEvent = { changes: [{ text: next }] }) {
    this.changeContent(next, event);
    this.pasteListeners.forEach((listener) => listener());
  }

  changeSelection(position: { lineNumber: number; column: number } | null, selection: Selection | null) {
    this.position = position;
    this.selection = selection;
    this.selectionListeners.forEach((listener) => listener());
  }

  changeScroll(scrollTop: number, scrollLeft: number) {
    this.scroll = { scrollTop, scrollLeft };
    this.scrollListeners.forEach((listener) => listener());
  }
}

function setup() {
  vi.useFakeTimers();
  let wall = 1000;
  const clock = createRecordingClock({ nowProvider: () => wall });
  const bus = createEventBus({ clock, wallTimeProvider: () => "T" });
  let language: RecordingLanguage = "javascript";
  let editor: MockEditor | null = null;
  const setModelLanguage = vi.fn((model: MockModel, next: RecordingLanguage) => {
    model.language = next;
    language = next;
  });
  const producer = createEditorProducer({
    bus,
    clock,
    getEditor: () => editor as never,
    getCurrentLanguage: () => language,
    setModelLanguage,
  } as unknown as EditorProducerDeps & {
    setModelLanguage: (model: MockModel, next: RecordingLanguage) => void;
  });

  clock.start();
  producer.start();

  return {
    bus,
    clock,
    producer,
    setEditor(next: MockEditor | null) {
      editor = next;
      vi.advanceTimersByTime(100);
    },
    setLanguage(next: RecordingLanguage) {
      language = next;
    },
    setWall(next: number) {
      wall = next;
    },
    setModelLanguage,
  };
}

function editor(value = "", language: RecordingLanguage = "javascript", theme: RecordingTheme = "dark") {
  return new MockEditor(
    new MockModel(value, language),
    { fontSize: 16, theme: `code-tape-${theme}` },
  );
}

describe("createEditorProducer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces content changes with debounce, idle flush, semantic flush, and hash dedupe", () => {
    const env = setup();
    const mounted = editor();
    env.setEditor(mounted);

    mounted.changeContent("a", { changes: [{ text: "a" }] });
    vi.advanceTimersByTime(299);
    expect(env.bus.drain()).toEqual([]);

    mounted.changeContent("ab", { changes: [{ text: "b" }] });
    vi.advanceTimersByTime(300);

    expect(env.bus.drain().map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      {
        type: "content-change",
        payload: expect.objectContaining({
          fileId: "main",
          version: 1,
          code: "ab",
          language: "javascript",
          changeReason: "input",
          changeCount: 2,
          flushedBy: "debounce",
        }),
      },
    ]);

    mounted.changeContent("abc", { changes: [{ text: "c" }] });
    vi.advanceTimersByTime(299);
    mounted.changeContent("abcd", { changes: [{ text: "d" }] });
    vi.advanceTimersByTime(299);
    mounted.changeContent("abcde", { changes: [{ text: "e" }] });
    vi.advanceTimersByTime(299);
    mounted.changeContent("abcdef", { changes: [{ text: "f" }] });
    vi.advanceTimersByTime(102);
    expect(env.bus.drain()).toEqual([]);
    vi.advanceTimersByTime(1);

    expect(env.bus.drain()[0]).toMatchObject({
      type: "content-change",
      payload: { version: 2, code: "abcdef", changeCount: 4, flushedBy: "idle" },
    });

    mounted.changeContent("abcdefg", { changes: [{ text: "g" }] });
    env.producer.flushPending();
    expect(env.bus.drain()[0]).toMatchObject({
      type: "content-change",
      payload: { version: 3, code: "abcdefg", flushedBy: "run" },
    });

    mounted.changeContent("abcdefg", { changes: [{ text: "" }] });
    vi.advanceTimersByTime(300);
    expect(env.bus.drain()).toEqual([]);

    mounted.changeContent("abcdefg\n", { changes: [{ text: "\n", rangeLength: 0 }] });
    vi.advanceTimersByTime(299);
    expect(env.bus.drain()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(env.bus.drain()[0]).toMatchObject({
      type: "content-change",
      payload: {
        version: 4,
        code: "abcdefg\n",
        changeReason: "input",
        flushedBy: "debounce",
      },
    });
  });

  it("flushes single-line paste from Monaco paste signal immediately", () => {
    const env = setup();
    const mounted = editor();
    env.setEditor(mounted);

    mounted.pasteContent("hello", { changes: [{ text: "hello" }] });

    expect(env.bus.drain()[0]).toMatchObject({
      type: "content-change",
      payload: {
        code: "hello",
        changeReason: "paste",
        flushedBy: "paste",
      },
    });
  });

  it("can mark the next content change as a format operation", () => {
    const env = setup();
    const mounted = editor("function demo(){\n\t\treturn 1;\n}");
    env.setEditor(mounted);

    env.producer.markNextChangeAsFormat();
    mounted.changeContent("function demo() {\n  return 1;\n}\n", {
      changes: [{ text: "function demo() {\n  return 1;\n}\n" }],
    });

    expect(env.bus.drain()[0]).toMatchObject({
      type: "content-change",
      payload: {
        code: "function demo() {\n  return 1;\n}\n",
        changeReason: "format",
        flushedBy: "format",
      },
    });
  });

  it("does not leak a canceled format signal into later edits", async () => {
    const env = setup();
    const mounted = editor("const value = 1;");
    env.setEditor(mounted);

    const cancel = env.producer.markNextChangeAsFormat();
    cancel();
    await Promise.resolve();
    mounted.changeContent("const value = 12;", { changes: [{ text: "2" }] });
    vi.advanceTimersByTime(300);

    expect(env.bus.drain()[0]).toMatchObject({
      type: "content-change",
      payload: {
        code: "const value = 12;",
        changeReason: "input",
        flushedBy: "debounce",
      },
    });
  });

  it("flushes paste, undo, redo, pause, stop, and snapshot boundaries immediately", async () => {
    const env = setup();
    const mounted = editor("old");
    env.setEditor(mounted);

    mounted.changeContent("first\nsecond", { changes: [{ text: "first\nsecond" }] });
    expect(env.bus.drain()[0]).toMatchObject({
      type: "content-change",
      payload: { changeReason: "paste", flushedBy: "paste", changeCount: 1 },
    });

    mounted.changeContent("first", { isUndoing: true, changes: [{ text: "", rangeLength: 7 }] });
    expect(env.bus.drain()[0]).toMatchObject({
      type: "content-change",
      payload: { changeReason: "undo", flushedBy: "undo" },
    });

    mounted.changeContent("first\nsecond", { isRedoing: true, changes: [{ text: "\nsecond" }] });
    expect(env.bus.drain()[0]).toMatchObject({
      type: "content-change",
      payload: { changeReason: "redo", flushedBy: "redo" },
    });

    mounted.changeContent("const formatted = true;\n", {
      changes: [{ text: "const" }, { text: " formatted" }],
    });
    expect(env.bus.drain()[0]).toMatchObject({
      type: "content-change",
      payload: { changeReason: "format", flushedBy: "format" },
    });

    mounted.changeContent("pending-pause", { changes: [{ text: "pending-pause" }] });
    env.producer.pause();
    expect(env.bus.drain()[0]).toMatchObject({
      type: "content-change",
      payload: { code: "pending-pause", flushedBy: "pause" },
    });

    env.producer.resume();
    mounted.changeContent("pending-snapshot", { changes: [{ text: "pending-snapshot" }] });
    await env.producer.takeSnapshot();
    expect(env.bus.drain()[0]).toMatchObject({
      type: "content-change",
      payload: { code: "pending-snapshot", flushedBy: "snapshot" },
    });

    mounted.changeContent("pending-stop", { changes: [{ text: "pending-stop" }] });
    env.producer.stop();
    expect(env.bus.drain()[0]).toMatchObject({
      type: "content-change",
      payload: { code: "pending-stop", flushedBy: "stop" },
    });
  });

  it("emits selection changes and throttled scroll events", () => {
    const env = setup();
    const mounted = editor();
    env.setEditor(mounted);

    mounted.changeSelection(
      { lineNumber: 2, column: 4 },
      { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 },
    );
    expect(env.bus.drain()[0]).toMatchObject({
      type: "selection-change",
      payload: {
        cursor: { lineNumber: 2, column: 4 },
        selection: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 },
      },
    });

    mounted.changeScroll(10, 1);
    mounted.changeScroll(20, 2);
    vi.advanceTimersByTime(99);
    expect(env.bus.drain()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(env.bus.drain()[0]).toMatchObject({
      type: "editor-scroll",
      payload: { scrollTop: 20, scrollLeft: 2 },
    });
  });

  it("reads latest dependency language for snapshots and resume baselines", async () => {
    const env = setup();
    const mounted = editor("const answer = 42;");
    env.setEditor(mounted);

    env.setLanguage("typescript");
    const snapshot = await env.producer.takeSnapshot();
    expect(snapshot?.state.editor.language).toBe("typescript");

    env.producer.pause();
    env.bus.drain();
    env.setLanguage("javascript");
    env.producer.resume();
    await Promise.resolve();

    expect(env.bus.drain()[0]).toMatchObject({
      type: "resume-baseline",
      payload: {
        reason: "paused-state-changed",
        snapshot: { editor: { language: "javascript" } },
      },
    });
  });

  it("updates model language, emits language-change once, and snapshots stable editor state", async () => {
    const env = setup();
    const mounted = editor("const answer = 42;", "javascript", "light");
    env.setEditor(mounted);

    env.producer.setLanguage("typescript");
    env.producer.setLanguage("typescript");

    expect(env.setModelLanguage).toHaveBeenCalledOnce();
    expect(env.bus.drain()).toEqual([
      expect.objectContaining({
        type: "language-change",
        payload: { from: "javascript", to: "typescript" },
      }),
    ]);

    mounted.changeSelection(
      { lineNumber: 1, column: 7 },
      { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 7 },
    );
    mounted.changeScroll(24, 3);
    vi.advanceTimersByTime(100);
    env.bus.drain();
    env.setWall(1250);

    const snapshot = await env.producer.takeSnapshot();

    expect(snapshot).toMatchObject({
      id: expect.stringMatching(/^snap-/),
      timestampMs: 250,
      state: {
        editor: {
          code: "const answer = 42;",
          language: "typescript",
          cursor: { lineNumber: 1, column: 7 },
          selection: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 7 },
          scrollTop: 24,
          scrollLeft: 3,
          fontSize: 16,
          theme: "light",
        },
      },
    });
  });

  it("uses the global last event seq for snapshots after the bus has drained", async () => {
    const env = setup();
    const mounted = editor();
    env.setEditor(mounted);

    mounted.changeContent("const drained = true;", { changes: [{ text: "const drained = true;" }] });
    env.producer.flushPending();
    const [contentEvent] = env.bus.drain();

    const snapshot = await env.producer.takeSnapshot();

    expect(snapshot?.eventSeq).toBe(contentEvent.seq);
  });

  it("flushes pending content before rebinding to a new editor instance", () => {
    const env = setup();
    const first = editor("first");
    env.setEditor(first);

    first.changeContent("first pending", { changes: [{ text: " pending" }] });
    vi.advanceTimersByTime(99);
    const second = editor("second");
    env.setEditor(second);

    expect(env.bus.drain()).toEqual([
      expect.objectContaining({
        type: "content-change",
        payload: expect.objectContaining({
          code: "first pending",
          flushedBy: "snapshot",
        }),
      }),
    ]);

    vi.advanceTimersByTime(300);
    expect(env.bus.drain()).toEqual([]);

    second.changeContent("second next", { changes: [{ text: " next" }] });
    vi.advanceTimersByTime(300);
    expect(env.bus.drain()).toEqual([
      expect.objectContaining({
        type: "content-change",
        payload: expect.objectContaining({ code: "second next" }),
      }),
    ]);
  });

  it("returns null before mount, rebinds editor instances, resumes with a baseline, and stays silent after terminal states", async () => {
    const env = setup();

    await expect(env.producer.takeSnapshot()).resolves.toBeNull();

    const first = editor("one");
    env.setEditor(first);
    first.changeContent("two", { changes: [{ text: "two" }] });
    env.producer.pause();
    env.bus.drain();

    first.changeContent("paused-edit", { changes: [{ text: "paused-edit" }] });
    expect(env.bus.drain()).toEqual([]);

    env.producer.resume();
    await Promise.resolve();
    expect(env.bus.drain()[0]).toMatchObject({
      type: "resume-baseline",
      payload: {
        reason: "paused-state-changed",
        snapshot: { editor: { code: "paused-edit" } },
      },
    });

    const second = editor("second");
    env.setEditor(second);
    first.changeContent("old-instance", { changes: [{ text: "old-instance" }] });
    second.changeContent("second-next", { changes: [{ text: "second-next" }] });
    vi.advanceTimersByTime(300);
    expect(env.bus.drain()).toEqual([
      expect.objectContaining({
        type: "content-change",
        payload: expect.objectContaining({ code: "second-next" }),
      }),
    ]);

    env.producer.stop();
    second.changeContent("stopped", { changes: [{ text: "stopped" }] });
    vi.advanceTimersByTime(300);
    expect(env.bus.drain()).toEqual([]);
    env.producer.start();
    second.changeContent("terminal", { changes: [{ text: "terminal" }] });
    vi.advanceTimersByTime(300);
    expect(env.bus.drain()).toEqual([]);

    env.producer.dispose();
    second.changeContent("disposed", { changes: [{ text: "disposed" }] });
    vi.advanceTimersByTime(300);
    expect(env.bus.drain()).toEqual([]);
  });
});
