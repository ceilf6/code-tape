import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorProducerDeps, EditorProducerHandle } from "@/features/capture/types";
import type { CodeEditorHandle } from "@/features/editor/CodeEditor";
import type { RecordingLanguage } from "@/shared/recording-schema";
import type * as ReactRouterDom from "react-router-dom";

const recorderPageMock = vi.hoisted(() => {
  const editorModel = {};
  const editorValue = { current: "" };
  const editor = {
    getValue: vi.fn(() => editorValue.current),
    getModel: vi.fn(() => editorModel),
  };
  const setModelLanguage = vi.fn();
  const navigate = vi.fn();
  const trigger = vi.fn(async () => ({
    runId: "run-test",
    status: "complete" as const,
    stdout: [],
    stderr: [],
    previewHtml: "<div>ok</div>",
  }));
  const flushPending = vi.fn();
  const editorProducer = {
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    flushPending,
    takeSnapshot: vi.fn(async () => null),
    setLanguage: vi.fn((next: RecordingLanguage) => {
      editorProducerDeps?.setModelLanguage?.(editorModel as never, next);
    }),
  } as unknown as EditorProducerHandle;
  let editorProducerDeps: EditorProducerDeps | null = null;

  return {
    editor,
    editorValue,
    setModelLanguage,
    navigate,
    trigger,
    flushPending,
    editorProducer,
    get editorProducerDeps() {
      return editorProducerDeps;
    },
    setEditorProducerDeps(next: EditorProducerDeps) {
      editorProducerDeps = next;
    },
    reset() {
      editorValue.current = "";
      editor.getValue.mockClear();
      editor.getModel.mockClear();
      setModelLanguage.mockClear();
      navigate.mockClear();
      trigger.mockClear();
      flushPending.mockClear();
      vi.mocked(editorProducer.start).mockClear();
      vi.mocked(editorProducer.pause).mockClear();
      vi.mocked(editorProducer.resume).mockClear();
      vi.mocked(editorProducer.stop).mockClear();
      vi.mocked(editorProducer.dispose).mockClear();
      vi.mocked(editorProducer.takeSnapshot).mockClear();
      vi.mocked(editorProducer.setLanguage).mockClear();
      editorProducerDeps = null;
    },
  };
});

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof ReactRouterDom>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => recorderPageMock.navigate,
  };
});

vi.mock("@/features/editor/CodeEditor", () => ({
  CodeEditor: forwardRef<CodeEditorHandle>(function MockCodeEditor(_props, ref) {
    useImperativeHandle(ref, () => ({
      getEditor: () => recorderPageMock.editor as never,
      setModelLanguage: recorderPageMock.setModelLanguage,
    }));
    return <div aria-label="Mock code editor" />;
  }),
}));

vi.mock("@/features/capture", () => ({
  createEditorProducer: vi.fn((deps: EditorProducerDeps) => {
    recorderPageMock.setEditorProducerDeps(deps);
    return recorderPageMock.editorProducer;
  }),
  createMediaProducer: vi.fn(() => ({
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    setMicrophoneEnabled: vi.fn(),
    setCameraEnabled: vi.fn(),
    reportCameraPosition: vi.fn(),
  })),
  createPointerProducer: vi.fn(() => ({
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
  })),
  createRuntimeProducer: vi.fn(() => ({
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    trigger: recorderPageMock.trigger,
  })),
  createShortcutProducer: vi.fn(() => ({
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
  })),
}));

describe("RecorderPage", () => {
  beforeEach(() => {
    recorderPageMock.reset();
  });

  it("runs with the current editor language after producer-driven language changes", async () => {
    const { RecorderPage } = await import("../RecorderPage");
    recorderPageMock.editorValue.current = "const value: number = 1;";

    render(<RecorderPage />);
    await waitFor(() => expect(recorderPageMock.editorProducerDeps).not.toBeNull());

    await act(async () => {
      recorderPageMock.editorProducer.setLanguage("typescript");
    });
    fireEvent.click(screen.getByRole("button", { name: "运行代码" }));

    await waitFor(() =>
      expect(recorderPageMock.trigger).toHaveBeenCalledWith({
        language: "typescript",
        source: "const value: number = 1;",
      }),
    );
    expect(recorderPageMock.flushPending).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.flushPending.mock.invocationCallOrder[0]).toBeLessThan(
      recorderPageMock.trigger.mock.invocationCallOrder[0],
    );
  });
});
