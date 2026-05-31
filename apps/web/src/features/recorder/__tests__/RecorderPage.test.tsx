import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EditorProducerDeps,
  EditorProducerHandle,
  MediaProducerDeps,
  PointerProducerDeps,
  RuntimeProducerHandle,
} from "@/features/capture/types";
import type { CodeEditorHandle, CodeEditorProps } from "@/features/editor/CodeEditor";
import type { CameraPreviewProps } from "@/features/media/CameraPreview";
import type {
  EventBus,
  MediaDevicesController,
  OpenStreamResult,
  RecordingRepository,
  RecordingLanguage,
  SaveDraftInput,
} from "@/shared/recording-schema";
import type * as SharedUi from "@/shared/ui";
import type * as ReactRouterDom from "react-router-dom";

const recorderPageMock = vi.hoisted(() => {
  const editorModel = {};
  const editorValue = { current: "" };
  const editor = {
    getValue: vi.fn(() => editorValue.current),
    getModel: vi.fn(() => editorModel),
  };
  const audioTrack = { kind: "audio" } as MediaStreamTrack;
  const videoTrack = { kind: "video" } as MediaStreamTrack;
  const getTracks = vi.fn(() => [audioTrack, videoTrack]);
  const getAudioTracks = vi.fn(() => [audioTrack]);
  const getVideoTracks = vi.fn(() => [videoTrack]);
  const setModelLanguage = vi.fn();
  const navigate = vi.fn();
  const trigger = vi.fn<RuntimeProducerHandle["trigger"]>(async () => ({
    runId: "run-test",
    status: "complete" as const,
    stdout: [],
    stderr: [],
    previewHtml: "<div>ok</div>",
  }));
  const flushPending = vi.fn();
  const markNextChangeAsFormat = vi.fn(() => vi.fn());
  const editorProducer = {
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    flushPending,
    markNextChangeAsFormat,
    takeSnapshot: vi.fn(async () => null),
    setLanguage: vi.fn((next: RecordingLanguage) => {
      editorProducerDeps?.setModelLanguage?.(editorModel as never, next);
    }),
  } as unknown as EditorProducerHandle;
  const mediaProducer = {
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    primeInitialState: vi.fn(),
    setMicrophoneEnabled: vi.fn(),
    setCameraEnabled: vi.fn(),
    reportCameraPosition: vi.fn(),
  };
  const pointerProducer = {
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
  };
  const runtimeProducer = {
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
    trigger,
  };
  const shortcutProducer = {
    start: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn(),
  };
  const stream = {
    getTracks,
    getAudioTracks,
    getVideoTracks,
  } as unknown as MediaStream;
  const devices = {
    enumerate: vi.fn<MediaDevicesController["enumerate"]>(async () => ({
      audio: [
        { deviceId: "mic-1", label: "Mic", kind: "audioinput" as const },
        { deviceId: "mic-2", label: "Desk Mic", kind: "audioinput" as const },
      ],
      camera: [
        { deviceId: "cam-1", label: "Camera", kind: "videoinput" as const },
        { deviceId: "cam-2", label: "Studio Camera", kind: "videoinput" as const },
      ],
    })),
    requestPermission: vi.fn(),
    openStream: vi.fn<MediaDevicesController["openStream"]>(async (request) => ({
      stream: request.audioDeviceId === null && request.cameraDeviceId === null ? null : stream,
      warnings: [],
      capability: {
        audio: "available" as const,
        camera: "available" as const,
        selectedAudioDeviceId: request.audioDeviceId ?? null,
        selectedCameraDeviceId: request.cameraDeviceId ?? null,
      },
    })),
    setTrackEnabled: vi.fn(),
    release: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
  };
  const mediaRecorder = {
    start: vi.fn(async () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(async () => ({
      blob: new Blob(["media"], { type: "video/webm" }),
      mimeType: "video/webm",
      durationMs: 1_000,
      hasAudio: true,
      hasCamera: true,
    })),
    onChunk: vi.fn(() => vi.fn()),
    onError: vi.fn(() => vi.fn()),
  };
  const createMediaRecorderWrapper = vi.fn(() => mediaRecorder);
  const repository = {
    saveDraft: vi.fn<RecordingRepository["saveDraft"]>(async (input: SaveDraftInput) => ({
      ok: true,
      recordingId: input.meta.id,
    })),
    commit: vi.fn<RecordingRepository["commit"]>(async (id: string) => ({ ok: true, recordingId: id })),
    list: vi.fn(),
    load: vi.fn(),
    loadThumbnail: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    exportZip: vi.fn(),
    importZip: vi.fn(),
    sweep: vi.fn(),
    estimateQuota: vi.fn<RecordingRepository["estimateQuota"]>(async () => ({
      usageBytes: 0,
      quotaBytes: 1024 * 1024 * 1024,
    })),
  };
  let editorProducerDeps: EditorProducerDeps | null = null;
  let mediaProducerDeps: MediaProducerDeps | null = null;
  let pointerProducerDeps: PointerProducerDeps | null = null;

  return {
    editor,
    editorValue,
    setModelLanguage,
    navigate,
    trigger,
    flushPending,
    editorProducer,
    mediaProducer,
    pointerProducer,
    runtimeProducer,
    shortcutProducer,
    stream,
    devices,
    mediaRecorder,
    createMediaRecorderWrapper,
    repository,
    codeEditorProps: null as CodeEditorProps | null,
    cameraPreviewProps: null as CameraPreviewProps | null,
    get editorProducerDeps() {
      return editorProducerDeps;
    },
    get mediaProducerDeps() {
      return mediaProducerDeps;
    },
    get pointerProducerDeps() {
      return pointerProducerDeps;
    },
    setEditorProducerDeps(next: EditorProducerDeps) {
      editorProducerDeps = next;
    },
    setMediaProducerDeps(next: MediaProducerDeps) {
      mediaProducerDeps = next;
    },
    setPointerProducerDeps(next: PointerProducerDeps) {
      pointerProducerDeps = next;
    },
    reset() {
      editorValue.current = "";
      editor.getValue.mockClear();
      editor.getModel.mockClear();
      setModelLanguage.mockClear();
      navigate.mockClear();
      trigger.mockClear();
      flushPending.mockClear();
      getTracks.mockClear();
      getAudioTracks.mockClear();
      getVideoTracks.mockClear();
      vi.mocked(editorProducer.start).mockClear();
      vi.mocked(editorProducer.pause).mockClear();
      vi.mocked(editorProducer.resume).mockClear();
      vi.mocked(editorProducer.stop).mockClear();
      vi.mocked(editorProducer.dispose).mockClear();
      vi.mocked(editorProducer.takeSnapshot).mockClear();
      vi.mocked(editorProducer.setLanguage).mockClear();
      vi.mocked(editorProducer.markNextChangeAsFormat).mockClear();
      mediaProducer.start.mockClear();
      mediaProducer.pause.mockClear();
      mediaProducer.resume.mockClear();
      mediaProducer.stop.mockClear();
      mediaProducer.dispose.mockClear();
      mediaProducer.primeInitialState.mockClear();
      mediaProducer.setMicrophoneEnabled.mockClear();
      mediaProducer.setCameraEnabled.mockClear();
      mediaProducer.reportCameraPosition.mockClear();
      pointerProducer.start.mockClear();
      pointerProducer.pause.mockClear();
      pointerProducer.resume.mockClear();
      pointerProducer.stop.mockClear();
      pointerProducer.dispose.mockClear();
      runtimeProducer.start.mockClear();
      runtimeProducer.pause.mockClear();
      runtimeProducer.resume.mockClear();
      runtimeProducer.stop.mockClear();
      runtimeProducer.dispose.mockClear();
      shortcutProducer.start.mockClear();
      shortcutProducer.pause.mockClear();
      shortcutProducer.resume.mockClear();
      shortcutProducer.stop.mockClear();
      shortcutProducer.dispose.mockClear();
      devices.enumerate.mockClear();
      devices.requestPermission.mockClear();
      devices.openStream.mockClear();
      devices.setTrackEnabled.mockClear();
      devices.release.mockClear();
      createMediaRecorderWrapper.mockClear();
      createMediaRecorderWrapper.mockImplementation(() => mediaRecorder);
      mediaRecorder.start.mockClear();
      mediaRecorder.pause.mockClear();
      mediaRecorder.resume.mockClear();
      mediaRecorder.stop.mockClear();
      repository.saveDraft.mockClear();
      repository.commit.mockClear();
      repository.estimateQuota.mockClear();
      this.codeEditorProps = null;
      this.cameraPreviewProps = null;
      editorProducerDeps = null;
      mediaProducerDeps = null;
      pointerProducerDeps = null;
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

vi.mock("@/shared/ui", async () => {
  const actual = await vi.importActual<typeof SharedUi>("@/shared/ui");
  return {
    ...actual,
    useTheme: () => ({
      preference: "dark" as const,
      resolved: "dark" as const,
      setPreference: vi.fn(),
      toggle: vi.fn(),
      tokens: {},
    }),
  };
});

vi.mock("@/features/editor/CodeEditor", () => ({
  CodeEditor: forwardRef<CodeEditorHandle, CodeEditorProps>(function MockCodeEditor(props, ref) {
    recorderPageMock.codeEditorProps = props;
    useImperativeHandle(ref, () => ({
      getEditor: () => recorderPageMock.editor as never,
      setModelLanguage: recorderPageMock.setModelLanguage,
    }));
    return <div aria-label="Mock code editor" data-code-editor />;
  }),
}));

vi.mock("@/features/media/CameraPreview", () => ({
  CameraPreview: (props: CameraPreviewProps) => {
    recorderPageMock.cameraPreviewProps = props;
    return (
      <button type="button" onClick={() => props.onPositionChange?.({ x: 0.25, y: 0.75 })}>
        Move camera preview
      </button>
    );
  },
}));

vi.mock("@/features/media/mediaDevices", () => ({
  createMediaDevicesController: vi.fn(() => recorderPageMock.devices),
}));

vi.mock("@/features/media/mediaRecorder", () => ({
  createMediaRecorderWrapper: recorderPageMock.createMediaRecorderWrapper,
}));

vi.mock("@/features/library/recordingStore", () => ({
  createRecordingStore: vi.fn(() => recorderPageMock.repository),
}));

vi.mock("@/features/capture", () => ({
  createEditorProducer: vi.fn((deps: EditorProducerDeps) => {
    recorderPageMock.setEditorProducerDeps(deps);
    return recorderPageMock.editorProducer;
  }),
  createMediaProducer: vi.fn((deps: MediaProducerDeps) => {
    recorderPageMock.setMediaProducerDeps(deps);
    return recorderPageMock.mediaProducer;
  }),
  createPointerProducer: vi.fn((deps: PointerProducerDeps) => {
    recorderPageMock.setPointerProducerDeps(deps);
    return {
      ...recorderPageMock.pointerProducer,
    };
  }),
  createRuntimeProducer: vi.fn(() => ({
    ...recorderPageMock.runtimeProducer,
  })),
  createShortcutProducer: vi.fn(() => ({
    ...recorderPageMock.shortcutProducer,
  })),
}));

function mockDownloadApis() {
  const createObjectURL = typeof URL.createObjectURL === "function"
    ? vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fallback")
    : vi.fn(() => "blob:fallback");
  if (typeof URL.createObjectURL !== "function") {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: createObjectURL,
    });
  }
  const revokeObjectURL = typeof URL.revokeObjectURL === "function"
    ? vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {})
    : vi.fn();
  if (typeof URL.revokeObjectURL !== "function") {
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: revokeObjectURL,
    });
  }
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return { createObjectURL, revokeObjectURL, click };
}

async function flushAsyncWork(turns = 6): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await Promise.resolve();
  }
}

describe("RecorderPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    recorderPageMock.reset();
  });

  afterEach(async () => {
    cleanup();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
  });

  it("exposes the recording EventBus to an optional realtime subscriber and cleans it up", async () => {
    const { RecorderPage } = await import("../RecorderPage");
    const cleanupSubscriber = vi.fn();
    const onEventBusReady = vi.fn(
      (_bus: Pick<EventBus, "peek" | "subscribe">) => cleanupSubscriber,
    );

    const { unmount } = render(<RecorderPage onEventBusReady={onEventBusReady} />);

    await waitFor(() => expect(onEventBusReady).toHaveBeenCalledTimes(1));
    expect(onEventBusReady.mock.calls[0][0].peek).toBeTypeOf("function");
    expect(onEventBusReady.mock.calls[0][0].subscribe).toBeTypeOf("function");

    unmount();

    expect(cleanupSubscriber).toHaveBeenCalledTimes(1);
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

  it("renders console output from a run in the recorder right panel", async () => {
    const { RecorderPage } = await import("../RecorderPage");
    recorderPageMock.editorValue.current = "console.log(1);";
    recorderPageMock.trigger.mockResolvedValueOnce({
      runId: "run-console",
      status: "complete",
      stdout: ["1"],
      stderr: [],
      previewHtml: "<body></body>",
    });

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "运行代码" }));

    const output = await screen.findByRole("region", { name: "Runtime output" });
    expect(output).toHaveTextContent("success");
    expect(output).toHaveTextContent("1");
  });

  it("lets users resize and persist the recorder workspace from the keyboard", async () => {
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    await waitFor(() => expect(recorderPageMock.devices.enumerate).toHaveBeenCalledTimes(1));

    const separator = screen.getByRole("separator", { name: "调整录制工作区宽度" });
    expect(separator).toHaveAttribute("aria-valuemin", "52");
    expect(separator).toHaveAttribute("aria-valuemax", "78");
    expect(separator).toHaveAttribute("aria-valuenow", "68");

    act(() => {
      fireEvent.keyDown(separator, { key: "ArrowLeft" });
    });

    expect(separator).toHaveAttribute("aria-valuenow", "64");
    expect(window.localStorage.getItem("code-tape:workspace:recorder:left-percent")).toBe("64");
  });

  it("runs code from the editor run command shortcut", async () => {
    const { RecorderPage } = await import("../RecorderPage");
    recorderPageMock.editorValue.current = "console.log('shortcut-run');";

    render(<RecorderPage />);
    await waitFor(() => expect(recorderPageMock.codeEditorProps?.onCommand).toBeTypeOf("function"));

    await act(async () => {
      recorderPageMock.codeEditorProps?.onCommand?.("run");
    });

    await waitFor(() =>
      expect(recorderPageMock.trigger).toHaveBeenCalledWith({
        language: "javascript",
        source: "console.log('shortcut-run');",
      }),
    );
    expect(recorderPageMock.flushPending).toHaveBeenCalledTimes(1);
  });

  it("marks editor fallback formatting as a format content change", async () => {
    const { RecorderPage } = await import("../RecorderPage");
    const cancel = vi.fn();
    vi.mocked(recorderPageMock.editorProducer.markNextChangeAsFormat).mockReturnValueOnce(cancel);

    render(<RecorderPage />);
    await waitFor(() => expect(recorderPageMock.codeEditorProps?.onBeforeFormatApply).toBeTypeOf("function"));

    expect(recorderPageMock.codeEditorProps?.onBeforeFormatApply?.()).toBe(cancel);
    expect(recorderPageMock.editorProducer.markNextChangeAsFormat).toHaveBeenCalledTimes(1);
  });

  it("automatically runs changed code after the editor is idle", async () => {
    vi.useFakeTimers();
    try {
      const { RecorderPage } = await import("../RecorderPage");
      recorderPageMock.editorValue.current = "console.log('first-auto-run');";

      render(<RecorderPage />);
      expect(recorderPageMock.codeEditorProps?.onChange).toBeTypeOf("function");

      act(() => {
        recorderPageMock.codeEditorProps?.onChange?.();
        vi.advanceTimersByTime(1_999);
      });

      expect(recorderPageMock.trigger).not.toHaveBeenCalled();

      recorderPageMock.editorValue.current = "console.log('second-auto-run');";
      act(() => {
        recorderPageMock.codeEditorProps?.onChange?.();
        vi.advanceTimersByTime(1_999);
      });

      expect(recorderPageMock.trigger).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1);
        await flushAsyncWork();
      });

      expect(recorderPageMock.trigger).toHaveBeenCalledWith({
        language: "javascript",
        source: "console.log('second-auto-run');",
      });
      expect(recorderPageMock.flushPending).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending automatic run when code is run manually", async () => {
    vi.useFakeTimers();
    try {
      const { RecorderPage } = await import("../RecorderPage");
      recorderPageMock.editorValue.current = "console.log('manual-run');";

      render(<RecorderPage />);
      expect(recorderPageMock.codeEditorProps?.onChange).toBeTypeOf("function");

      act(() => {
        recorderPageMock.codeEditorProps?.onChange?.();
        vi.advanceTimersByTime(1_000);
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "运行代码" }));
        await flushAsyncWork();
      });

      act(() => {
        vi.advanceTimersByTime(1_000);
      });

      expect(recorderPageMock.trigger).toHaveBeenCalledTimes(1);
      expect(recorderPageMock.trigger).toHaveBeenCalledWith({
        language: "javascript",
        source: "console.log('manual-run');",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not automatically run after recording is paused", async () => {
    const { RecorderPage } = await import("../RecorderPage");
    recorderPageMock.editorValue.current = "console.log('paused-auto-run');";

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(recorderPageMock.mediaRecorder.start).toHaveBeenCalledWith(recorderPageMock.stream));

    vi.useFakeTimers();
    try {
      act(() => {
        recorderPageMock.codeEditorProps?.onChange?.();
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "暂停录制" }));
        await flushAsyncWork();
      });

      act(() => {
        vi.advanceTimersByTime(2_000);
      });

      expect(recorderPageMock.trigger).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("requests browser media permissions from the setup toolbar and refreshes devices", async () => {
    recorderPageMock.devices.requestPermission.mockResolvedValue("granted");
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    await waitFor(() => expect(recorderPageMock.devices.enumerate).toHaveBeenCalledTimes(1));
    recorderPageMock.devices.enumerate.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "申请设备权限" }));

    await waitFor(() => expect(recorderPageMock.devices.requestPermission).toHaveBeenCalledWith("audio"));
    expect(recorderPageMock.devices.requestPermission).toHaveBeenCalledWith("camera");
    await waitFor(() => expect(recorderPageMock.devices.enumerate).toHaveBeenCalledTimes(1));
  });

  it("keeps producers reusable after StrictMode idle cleanup", async () => {
    const { RecorderPage } = await import("../RecorderPage");
    recorderPageMock.editorValue.current = "console.log('strict-mode-ready');";

    render(
      <StrictMode>
        <RecorderPage />
      </StrictMode>,
    );

    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() => expect(recorderPageMock.mediaRecorder.start).toHaveBeenCalledWith(recorderPageMock.stream));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(recorderPageMock.runtimeProducer.dispose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "运行代码" }));

    await waitFor(() =>
      expect(recorderPageMock.trigger).toHaveBeenCalledWith({
        language: "javascript",
        source: "console.log('strict-mode-ready');",
      }),
    );
  });

  it("disposes producers when the recorder page unmounts before recording starts", async () => {
    const { RecorderPage } = await import("../RecorderPage");

    const { unmount } = render(<RecorderPage />);
    unmount();

    await waitFor(() => expect(recorderPageMock.runtimeProducer.dispose).toHaveBeenCalled());
    expect(recorderPageMock.editorProducer.dispose).toHaveBeenCalled();
    expect(recorderPageMock.pointerProducer.dispose).toHaveBeenCalled();
    expect(recorderPageMock.shortcutProducer.dispose).toHaveBeenCalled();
    expect(recorderPageMock.mediaProducer.dispose).toHaveBeenCalled();
  });

  it("reports camera preview position changes to the media producer", async () => {
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "麦克风设备" })).toHaveValue("mic-1"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move camera preview" }));

    expect(recorderPageMock.mediaProducer.reportCameraPosition).toHaveBeenCalledWith({
      x: 0.25,
      y: 0.75,
    });
  });

  it("scopes pointer capture to the editor surface", async () => {
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    await waitFor(() => expect(recorderPageMock.pointerProducerDeps).not.toBeNull());

    expect(recorderPageMock.pointerProducerDeps?.getHost()?.hasAttribute("data-code-editor")).toBe(
      true,
    );
  });

  it("opens the selected media stream and starts media recording before controller start", async () => {
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() =>
      expect(recorderPageMock.devices.openStream).toHaveBeenCalledWith({
        audioDeviceId: "mic-1",
        cameraDeviceId: "cam-1",
      }),
    );
    expect(recorderPageMock.mediaRecorder.start).toHaveBeenCalledWith(recorderPageMock.stream);
    expect(recorderPageMock.cameraPreviewProps?.stream).toBe(recorderPageMock.stream);
    expect(recorderPageMock.mediaProducerDeps?.getCapability()).toEqual(
      expect.objectContaining({
        audio: "available",
        camera: "available",
        selectedAudioDeviceId: "mic-1",
        selectedCameraDeviceId: "cam-1",
      }),
    );
  });

  it("refreshes the elapsed duration while recording", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T00:00:00.000Z"));
    try {
      const { RecorderPage } = await import("../RecorderPage");

      render(<RecorderPage />);
      await act(async () => {
        await flushAsyncWork();
      });
      fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
      await act(async () => {
        await flushAsyncWork();
      });

      expect(screen.getByText("录制中")).toBeInTheDocument();
      expect(screen.getByText("00:00")).toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(1_250);
        await flushAsyncWork();
      });

      expect(screen.getByText("00:01")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("primes initial media state and camera position after recording starts", async () => {
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() => expect(recorderPageMock.mediaProducer.start).toHaveBeenCalledTimes(1));
    expect(recorderPageMock.mediaProducer.primeInitialState).toHaveBeenCalledWith({
      microphoneEnabled: true,
      cameraEnabled: true,
      cameraPosition: { x: 0.85, y: 0.85 },
    });
    expect(recorderPageMock.mediaProducer.start.mock.invocationCallOrder[0]).toBeLessThan(
      recorderPageMock.mediaProducer.primeInitialState.mock.invocationCallOrder[0],
    );
  });

  it("uses pre-recording toolbar selections for editor and media setup", async () => {
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    fireEvent.change(await screen.findByRole("combobox", { name: "语言" }), {
      target: { value: "typescript" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "字号" }), {
      target: { value: "16" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "麦克风设备" }), {
      target: { value: "mic-2" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "摄像头设备" }), {
      target: { value: "cam-2" },
    });

    expect(recorderPageMock.codeEditorProps).toEqual(
      expect.objectContaining({
        language: "typescript",
        fontSize: 16,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() =>
      expect(recorderPageMock.devices.openStream).toHaveBeenCalledWith({
        audioDeviceId: "mic-2",
        cameraDeviceId: "cam-2",
      }),
    );
    await waitFor(() =>
      expect(recorderPageMock.trigger).not.toHaveBeenCalled(),
    );
  });

  it("does not overwrite an explicit no-device selection when enumeration finishes", async () => {
    let resolveDevices!: (devices: Awaited<ReturnType<MediaDevicesController["enumerate"]>>) => void;
    const enumeratePromise = new Promise<Awaited<ReturnType<MediaDevicesController["enumerate"]>>>(
      (resolve) => {
        resolveDevices = resolve;
      },
    );
    recorderPageMock.devices.enumerate.mockReturnValueOnce(enumeratePromise);
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    const audioSelect = screen.getByRole("combobox", { name: "麦克风设备" });
    const cameraSelect = screen.getByRole("combobox", { name: "摄像头设备" });

    fireEvent.change(audioSelect, { target: { value: "" } });
    fireEvent.change(cameraSelect, { target: { value: "" } });
    await act(async () => {
      resolveDevices({
        audio: [{ deviceId: "mic-late", label: "Late Mic", kind: "audioinput" }],
        camera: [{ deviceId: "cam-late", label: "Late Camera", kind: "videoinput" }],
      });
      await enumeratePromise;
    });

    await waitFor(() => expect(audioSelect).toHaveValue(""));
    expect(cameraSelect).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() => expect(recorderPageMock.mediaProducer.start).toHaveBeenCalledTimes(1));
    expect(recorderPageMock.devices.openStream).toHaveBeenCalledWith({
      audioDeviceId: null,
      cameraDeviceId: null,
    });
    expect(recorderPageMock.mediaProducerDeps?.getCapability()).toEqual({
      audio: "available",
      camera: "available",
      selectedAudioDeviceId: null,
      selectedCameraDeviceId: null,
    });
  });

  it("falls back to event-only recording when the media recorder cannot start", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recorderPageMock.mediaRecorder.start.mockRejectedValueOnce(new Error("MediaRecorder unsupported"));
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() => expect(recorderPageMock.devices.release).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(recorderPageMock.mediaProducer.start).toHaveBeenCalledTimes(1));
    expect(recorderPageMock.mediaRecorder.stop).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.mediaProducerDeps?.getCapability()).toEqual({
      audio: "unsupported",
      camera: "unsupported",
      selectedAudioDeviceId: null,
      selectedCameraDeviceId: null,
    });
    expect(recorderPageMock.cameraPreviewProps?.stream).toBeNull();
    warn.mockRestore();
  });

  it("falls back to event-only recording when the media recorder factory throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recorderPageMock.createMediaRecorderWrapper.mockImplementationOnce(() => {
      throw new Error("MediaRecorder constructor failed");
    });
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() => expect(recorderPageMock.devices.release).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(recorderPageMock.mediaProducer.start).toHaveBeenCalledTimes(1));
    expect(recorderPageMock.mediaProducerDeps?.getCapability()).toEqual({
      audio: "unsupported",
      camera: "unsupported",
      selectedAudioDeviceId: null,
      selectedCameraDeviceId: null,
    });
    expect(recorderPageMock.mediaRecorder.start).not.toHaveBeenCalled();
    expect(recorderPageMock.cameraPreviewProps?.stream).toBeNull();
    warn.mockRestore();
  });

  it("delegates active media track toggles to the media producer", async () => {
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(recorderPageMock.mediaRecorder.start).toHaveBeenCalledWith(recorderPageMock.stream));

    fireEvent.click(screen.getByRole("button", { name: "关闭麦克风" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭摄像头" }));

    expect(recorderPageMock.devices.setTrackEnabled).not.toHaveBeenCalled();
    expect(recorderPageMock.mediaProducer.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    expect(recorderPageMock.mediaProducer.setCameraEnabled).toHaveBeenCalledWith(false);
  });

  it("locks editor, run, media toggles, and camera drag while paused", async () => {
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(recorderPageMock.mediaRecorder.start).toHaveBeenCalledWith(recorderPageMock.stream));

    fireEvent.click(screen.getByRole("button", { name: "暂停录制" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "继续录制" })).not.toBeDisabled());
    expect(recorderPageMock.codeEditorProps?.readOnly).toBe(true);
    expect(recorderPageMock.cameraPreviewProps?.draggable).toBe(false);
    expect(screen.getByRole("button", { name: "运行代码" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭麦克风" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭摄像头" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "运行代码" }));

    expect(recorderPageMock.trigger).not.toHaveBeenCalled();
    expect(recorderPageMock.devices.setTrackEnabled).not.toHaveBeenCalled();
    expect(recorderPageMock.mediaProducer.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(recorderPageMock.mediaProducer.setCameraEnabled).not.toHaveBeenCalled();
  });

  it("pauses event producers before pausing the media recorder", async () => {
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(recorderPageMock.mediaRecorder.start).toHaveBeenCalledWith(recorderPageMock.stream));

    fireEvent.click(screen.getByRole("button", { name: "暂停录制" }));

    expect(recorderPageMock.editorProducer.pause).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.mediaRecorder.pause).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recorderPageMock.editorProducer.pause).mock.invocationCallOrder[0]).toBeLessThan(
      recorderPageMock.mediaRecorder.pause.mock.invocationCallOrder[0],
    );
  });

  it("rolls event producers back to recording when media pause fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recorderPageMock.mediaRecorder.pause.mockImplementationOnce(() => {
      throw new Error("pause failed");
    });
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(recorderPageMock.mediaRecorder.start).toHaveBeenCalledWith(recorderPageMock.stream));

    fireEvent.click(screen.getByRole("button", { name: "暂停录制" }));

    await waitFor(() => expect(recorderPageMock.editorProducer.resume).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "暂停录制" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "继续录制" })).toBeDisabled();
    warn.mockRestore();
  });

  it("keeps event producers paused when media resume fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recorderPageMock.mediaRecorder.resume.mockImplementationOnce(() => {
      throw new Error("resume failed");
    });
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(recorderPageMock.mediaRecorder.start).toHaveBeenCalledWith(recorderPageMock.stream));
    fireEvent.click(screen.getByRole("button", { name: "暂停录制" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "继续录制" })).not.toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "继续录制" }));

    expect(recorderPageMock.mediaRecorder.resume).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.editorProducer.resume).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "继续录制" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "暂停录制" })).toBeDisabled();
    warn.mockRestore();
  });

  it("releases media resources when the recorder page unmounts", async () => {
    const { RecorderPage } = await import("../RecorderPage");

    const { unmount } = render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(recorderPageMock.mediaRecorder.start).toHaveBeenCalledWith(recorderPageMock.stream));

    unmount();

    expect(recorderPageMock.mediaRecorder.stop).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.devices.release).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.editorProducer.stop).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.editorProducer.dispose).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.pointerProducer.stop).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.pointerProducer.dispose).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.shortcutProducer.stop).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.shortcutProducer.dispose).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.mediaProducer.stop).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.mediaProducer.dispose).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.runtimeProducer.stop).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.runtimeProducer.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes producers when the recorder page unmounts after completion", async () => {
    const { RecorderPage } = await import("../RecorderPage");

    const { unmount } = render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(recorderPageMock.mediaRecorder.start).toHaveBeenCalledWith(recorderPageMock.stream));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止录制" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "停止录制" }));
    await waitFor(() => expect(recorderPageMock.navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/replay\/rec-/)));

    unmount();

    expect(recorderPageMock.editorProducer.dispose).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.pointerProducer.dispose).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.shortcutProducer.dispose).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.mediaProducer.dispose).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.runtimeProducer.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not continue starting recording when media opening resolves after unmount", async () => {
    const { RecorderPage } = await import("../RecorderPage");
    let resolveOpenStream!: (result: OpenStreamResult) => void;
    const openStream = new Promise<OpenStreamResult>((resolve) => {
      resolveOpenStream = resolve;
    });
    recorderPageMock.devices.openStream.mockReturnValueOnce(openStream);

    const { unmount } = render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(recorderPageMock.devices.openStream).toHaveBeenCalledTimes(1));

    unmount();
    expect(recorderPageMock.devices.release).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveOpenStream({
        stream: recorderPageMock.stream,
        warnings: [],
        capability: {
          audio: "available",
          camera: "available",
          selectedAudioDeviceId: "mic-1",
          selectedCameraDeviceId: "cam-1",
        },
      });
      await openStream;
    });

    expect(recorderPageMock.devices.release).toHaveBeenCalledTimes(2);
    expect(recorderPageMock.mediaRecorder.start).not.toHaveBeenCalled();
    expect(recorderPageMock.editorProducer.start).not.toHaveBeenCalled();
    expect(recorderPageMock.mediaProducer.start).not.toHaveBeenCalled();
  });

  it("ignores repeated starts while media opening is pending", async () => {
    const { RecorderPage } = await import("../RecorderPage");
    let resolveOpenStream!: (result: OpenStreamResult) => void;
    const openStream = new Promise<OpenStreamResult>((resolve) => {
      resolveOpenStream = resolve;
    });
    recorderPageMock.devices.openStream.mockReturnValueOnce(openStream);

    render(<RecorderPage />);
    const startButton = screen.getByRole("button", { name: "开始录制" });
    fireEvent.click(startButton);
    fireEvent.click(startButton);

    await waitFor(() => expect(recorderPageMock.devices.openStream).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveOpenStream({
        stream: recorderPageMock.stream,
        warnings: [],
        capability: {
          audio: "available",
          camera: "available",
          selectedAudioDeviceId: "mic-1",
          selectedCameraDeviceId: "cam-1",
        },
      });
      await openStream;
    });

    await waitFor(() => expect(recorderPageMock.mediaRecorder.start).toHaveBeenCalledTimes(1));
    expect(recorderPageMock.editorProducer.start).toHaveBeenCalledTimes(1);
  });

  it("does not start the controller when media recorder start resolves after unmount", async () => {
    const { RecorderPage } = await import("../RecorderPage");
    let resolveStart!: () => void;
    const recorderStart = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    recorderPageMock.mediaRecorder.start.mockReturnValueOnce(recorderStart);

    const { unmount } = render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() =>
      expect(recorderPageMock.mediaRecorder.start).toHaveBeenCalledWith(recorderPageMock.stream),
    );

    unmount();

    await act(async () => {
      resolveStart();
      await recorderStart;
    });

    expect(recorderPageMock.mediaRecorder.stop).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.devices.release).toHaveBeenCalled();
    expect(recorderPageMock.editorProducer.start).not.toHaveBeenCalled();
    expect(recorderPageMock.mediaProducer.start).not.toHaveBeenCalled();
  });

  it("saves without navigating when stop finishes after unmount", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { RecorderPage } = await import("../RecorderPage");
    let resolveStop!: (result: Awaited<ReturnType<typeof recorderPageMock.mediaRecorder.stop>>) => void;
    const stopPromise = new Promise<Awaited<ReturnType<typeof recorderPageMock.mediaRecorder.stop>>>(
      (resolve) => {
        resolveStop = resolve;
      },
    );
    recorderPageMock.mediaRecorder.stop.mockReturnValueOnce(stopPromise);

    const { unmount } = render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(recorderPageMock.mediaRecorder.start).toHaveBeenCalledWith(recorderPageMock.stream));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止录制" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "停止录制" }));
    await waitFor(() => expect(recorderPageMock.mediaRecorder.stop).toHaveBeenCalledTimes(1));

    unmount();
    expect(recorderPageMock.devices.release).not.toHaveBeenCalled();
    await act(async () => {
      resolveStop({
        blob: new Blob(["media"], { type: "video/webm" }),
        mimeType: "video/webm",
        durationMs: 1_000,
        hasAudio: true,
        hasCamera: true,
      });
      await stopPromise;
    });

    await waitFor(() => expect(recorderPageMock.repository.saveDraft).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(recorderPageMock.repository.commit).toHaveBeenCalledTimes(1));
    expect(recorderPageMock.devices.release).toHaveBeenCalledTimes(1);
    expect(recorderPageMock.navigate).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith("[recorder-page] stop ignored after unmount:", expect.any(Error));
    warn.mockRestore();
  });

  it("continues event-only recording when opening media fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recorderPageMock.devices.openStream.mockRejectedValueOnce(new Error("device busy"));
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() => expect(recorderPageMock.devices.release).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(recorderPageMock.mediaProducer.start).toHaveBeenCalledTimes(1));
    expect(recorderPageMock.mediaProducerDeps?.getCapability()).toEqual({
      audio: "unsupported",
      camera: "unsupported",
      selectedAudioDeviceId: null,
      selectedCameraDeviceId: null,
    });
    expect(recorderPageMock.cameraPreviewProps?.stream).toBeNull();
    warn.mockRestore();
  });

  it("continues event-only recording when opening media returns no stream", async () => {
    recorderPageMock.devices.openStream.mockResolvedValueOnce({
      stream: null,
      warnings: [{ target: "audio", code: "permission-denied", message: "blocked" }],
      capability: {
        audio: "denied",
        camera: "not-found",
        selectedAudioDeviceId: "mic-1",
        selectedCameraDeviceId: "cam-1",
      },
    });
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() => expect(recorderPageMock.devices.release).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(recorderPageMock.mediaProducer.start).toHaveBeenCalledTimes(1));
    expect(recorderPageMock.mediaRecorder.start).not.toHaveBeenCalled();
    expect(recorderPageMock.mediaProducerDeps?.getCapability()).toEqual({
      audio: "denied",
      camera: "not-found",
      selectedAudioDeviceId: "mic-1",
      selectedCameraDeviceId: "cam-1",
    });
    expect(recorderPageMock.cameraPreviewProps?.stream).toBeNull();
  });

  it("continues event-only recording when device enumeration fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recorderPageMock.devices.enumerate.mockRejectedValueOnce(new Error("blocked"));
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));

    await waitFor(() => expect(recorderPageMock.devices.release).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(recorderPageMock.mediaProducer.start).toHaveBeenCalledTimes(1));
    expect(recorderPageMock.devices.openStream).not.toHaveBeenCalled();
    expect(recorderPageMock.mediaProducerDeps?.getCapability()).toEqual({
      audio: "unsupported",
      camera: "unsupported",
      selectedAudioDeviceId: null,
      selectedCameraDeviceId: null,
    });
    warn.mockRestore();
  });

  it("saves the event recording when media finalization fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    recorderPageMock.mediaRecorder.stop.mockRejectedValueOnce(new Error("InvalidStateError"));
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(recorderPageMock.mediaRecorder.start).toHaveBeenCalledWith(recorderPageMock.stream));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止录制" })).not.toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "停止录制" }));

    await waitFor(() => expect(recorderPageMock.mediaRecorder.stop).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(recorderPageMock.navigate).toHaveBeenCalledWith(expect.stringMatching(/^\/replay\/rec-/)));
    expect(recorderPageMock.devices.release).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("downloads a fallback package when local persistence fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const downloadApis = mockDownloadApis();
    recorderPageMock.repository.saveDraft.mockResolvedValueOnce({
      ok: false,
      reason: "quota-exceeded",
      message: "IndexedDB quota exceeded",
    });
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(recorderPageMock.mediaRecorder.start).toHaveBeenCalledWith(recorderPageMock.stream));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止录制" })).not.toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "停止录制" }));

    await waitFor(() => expect(downloadApis.createObjectURL).toHaveBeenCalledWith(expect.any(Blob)));
    expect(downloadApis.click).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent("保存未进入本地回放中心");
    expect(recorderPageMock.navigate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole("button", { name: "开始录制" })).not.toBeDisabled());
    expect(screen.getByRole("button", { name: "停止录制" })).toBeDisabled();
    expect(recorderPageMock.devices.release).toHaveBeenCalled();

    warn.mockRestore();
    downloadApis.click.mockRestore();
    if ("mockRestore" in downloadApis.createObjectURL) downloadApis.createObjectURL.mockRestore();
    if ("mockRestore" in downloadApis.revokeObjectURL) downloadApis.revokeObjectURL.mockRestore();
  });

  it("shows fallback guidance when quota preflight blocks local save", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const downloadApis = mockDownloadApis();
    recorderPageMock.repository.estimateQuota.mockResolvedValueOnce({
      usageBytes: 1020 * 1024,
      quotaBytes: 1024 * 1024,
    });
    const { RecorderPage } = await import("../RecorderPage");

    render(<RecorderPage />);
    fireEvent.click(screen.getByRole("button", { name: "开始录制" }));
    await waitFor(() => expect(recorderPageMock.mediaRecorder.start).toHaveBeenCalledWith(recorderPageMock.stream));
    await waitFor(() => expect(screen.getByRole("button", { name: "停止录制" })).not.toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "停止录制" }));

    await waitFor(() => expect(downloadApis.click).toHaveBeenCalledTimes(1));
    expect(recorderPageMock.repository.saveDraft).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("ZIP 兜底文件");
    expect(recorderPageMock.navigate).not.toHaveBeenCalled();

    warn.mockRestore();
    downloadApis.click.mockRestore();
    if ("mockRestore" in downloadApis.createObjectURL) downloadApis.createObjectURL.mockRestore();
    if ("mockRestore" in downloadApis.revokeObjectURL) downloadApis.revokeObjectURL.mockRestore();
  });
});
