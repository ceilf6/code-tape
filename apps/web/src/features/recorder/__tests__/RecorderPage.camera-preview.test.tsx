import { act, fireEvent, render, screen } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorProducerHandle } from "@/features/capture/types";
import type { CodeEditorHandle } from "@/features/editor/CodeEditor";
import { ThemeProvider } from "@/shared/ui";
import type * as ReactRouterDom from "react-router-dom";

const recorderPageCameraPreviewMock = vi.hoisted(() => {
  const editor = {
    getValue: vi.fn(() => ""),
    getModel: vi.fn(() => ({})),
  };
  const navigate = vi.fn();
  const mediaProducer = {
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    setMicrophoneEnabled: vi.fn(),
    setCameraEnabled: vi.fn(),
    reportCameraPosition: vi.fn(),
  };
  const editorProducer = {
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    flushPending: vi.fn(),
    markNextChangeAsFormat: vi.fn(() => vi.fn()),
    takeSnapshot: vi.fn(async () => null),
  } as unknown as EditorProducerHandle;

  return {
    editor,
    navigate,
    mediaProducer,
    editorProducer,
    reset() {
      editor.getValue.mockClear();
      editor.getModel.mockClear();
      navigate.mockClear();
      mediaProducer.reportCameraPosition.mockClear();
      mediaProducer.setCameraEnabled.mockClear();
    },
  };
});

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof ReactRouterDom>("react-router-dom");
  return {
    ...actual,
    useNavigate: () => recorderPageCameraPreviewMock.navigate,
  };
});

vi.mock("@/features/editor/CodeEditor", () => ({
  CodeEditor: forwardRef<CodeEditorHandle>(function MockCodeEditor(_props, ref) {
    useImperativeHandle(ref, () => ({
      getEditor: () => recorderPageCameraPreviewMock.editor as never,
      setModelLanguage: vi.fn(),
    }));
    return <div aria-label="Mock code editor" />;
  }),
}));

vi.mock("@/features/capture", () => ({
  createEditorProducer: vi.fn(() => recorderPageCameraPreviewMock.editorProducer),
  createMediaProducer: vi.fn(() => recorderPageCameraPreviewMock.mediaProducer),
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
    trigger: vi.fn(),
  })),
  createShortcutProducer: vi.fn(() => ({
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
  })),
}));

describe("RecorderPage camera preview integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    if (!window.PointerEvent) {
      vi.stubGlobal("PointerEvent", MouseEvent);
    }
    recorderPageCameraPreviewMock.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reports normalized coordinates from the real CameraPreview drag path", async () => {
    const { RecorderPage } = await import("../RecorderPage");

    render(
      <ThemeProvider>
        <RecorderPage />
      </ThemeProvider>,
    );
    await act(async () => {});

    const preview = screen.getByRole("img", { name: "Camera preview placeholder" });
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
      width: 100,
      height: 100,
      top: 0,
      left: 0,
      bottom: 100,
      right: 100,
      x: 0,
      y: 0,
      toJSON: () => {},
    });
    vi.spyOn(preview.parentElement!, "getBoundingClientRect").mockReturnValue({
      width: 1000,
      height: 1000,
      top: 0,
      left: 0,
      bottom: 1000,
      right: 1000,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    fireEvent.pointerDown(preview, { clientX: 850, clientY: 850, pointerId: 1 });
    vi.setSystemTime(60);
    fireEvent.pointerMove(preview, { clientX: 895, clientY: 805, pointerId: 1 });

    expect(recorderPageCameraPreviewMock.mediaProducer.reportCameraPosition).toHaveBeenCalledWith({
      x: 0.9,
      y: 0.8,
    });
  });
});
