import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplayControlsProps } from "../ReplayControls";
import type { CodeEditorProps } from "@/features/editor/CodeEditor";
import type { PreviewPaneProps } from "@/features/runtime-preview/PreviewPane";
import type { SubtitlePanelProps } from "@/features/subtitles";
import type {
  RecordingEvent,
  MediaClockAdapter,
  RecordingPackageV1,
  RecordingRepository,
  ReplaySchedulerState,
  ReplayStableState,
} from "@/shared/recording-schema";
import type * as ReactRouterDom from "react-router-dom";

const replayPageMock = vi.hoisted(() => {
  const schedulerState: ReplaySchedulerState = {
    status: "ready",
    timelineTimeMs: 0,
    playbackRate: 1,
    lastAppliedSeq: 0,
    mediaStatus: "none",
    driftMs: 0,
  };
  const packageData: RecordingPackageV1 = {
    schemaVersion: "0.1.0",
    manifest: {
      packageId: "recording-1",
      schemaVersion: "0.1.0",
      status: "complete",
      createdAt: "2026-05-26T00:00:00.000Z",
      completedAt: "2026-05-26T00:01:00.000Z",
      checksums: { eventsSha256: "events", snapshotsSha256: "snapshots" },
    },
    meta: {
      id: "recording-1",
      title: "Replay controls",
      createdAt: "2026-05-26T00:00:00.000Z",
      durationMs: 120_000,
      appVersion: "test",
      ownerId: null,
      creatorInfo: null,
      initialLanguage: "javascript",
      initialFontSize: 14,
      initialTheme: "dark",
      mediaCapability: {
        audio: "unsupported",
        camera: "unsupported",
        selectedAudioDeviceId: null,
        selectedCameraDeviceId: null,
      },
    },
    events: [],
    snapshots: [],
    media: {
      blobId: "blob-1",
      mimeType: "video/webm",
      durationMs: 120_000,
      sizeBytes: 4,
      timelineOffsetMs: 0,
      hasAudio: true,
      hasCamera: true,
    },
  };
  const scheduler = {
    load: vi.fn(async () => {}),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(async () => {}),
    setRate: vi.fn(),
    setVolume: vi.fn(),
    setMuted: vi.fn(),
    setMediaAdapter: vi.fn(),
    destroy: vi.fn(),
    subscribe: vi.fn((listener: (state: typeof schedulerState) => void) => {
      listener(schedulerState);
      return vi.fn();
    }),
  };
  const repository = {
    load: vi.fn<RecordingRepository["load"]>(async () => ({
      ok: true as const,
      package: packageData,
      mediaBlob: new Blob(["webm"], { type: "video/webm" }),
      warnings: [],
    })),
  };
  const cloudRepository = {
    getPlaybackDescriptor: vi.fn(),
  };
  const cloudLoader = {
    load: vi.fn<RecordingRepository["load"]>(async () => ({
      ok: true as const,
      package: packageData,
      mediaBlob: new Blob(["webm"], { type: "video/webm" }),
      warnings: [],
    })),
  };
  const createCloudRecordingRepository = vi.fn(() => cloudRepository);
  const createCloudPackageLoader = vi.fn(() => cloudLoader);

  return {
    scheduler,
    schedulerState,
    repository,
    cloudRepository,
    cloudLoader,
    createCloudRecordingRepository,
    createCloudPackageLoader,
    packageData,
    routeId: "recording-1",
    search: "",
    controlsProps: null as ReplayControlsProps | null,
    codeEditorProps: null as CodeEditorProps | null,
    previewPaneProps: null as PreviewPaneProps | null,
    subtitlePanelProps: null as SubtitlePanelProps | null,
    onTick: null as ((state: ReplayStableState, events?: RecordingEvent[], timelineTimeMs?: number) => void) | null,
    reset() {
      scheduler.load.mockClear();
      scheduler.play.mockClear();
      scheduler.pause.mockClear();
      scheduler.seek.mockClear();
      scheduler.setRate.mockClear();
      scheduler.setVolume.mockClear();
      scheduler.setMuted.mockClear();
      scheduler.setMediaAdapter.mockClear();
      scheduler.destroy.mockClear();
      scheduler.subscribe.mockClear();
      schedulerState.status = "ready";
      schedulerState.timelineTimeMs = 0;
      schedulerState.playbackRate = 1;
      schedulerState.lastAppliedSeq = 0;
      schedulerState.mediaStatus = "none";
      schedulerState.driftMs = 0;
      repository.load.mockClear();
      cloudRepository.getPlaybackDescriptor.mockClear();
      cloudLoader.load.mockClear();
      createCloudRecordingRepository.mockClear();
      createCloudPackageLoader.mockClear();
      this.routeId = "recording-1";
      this.search = "";
      this.controlsProps = null;
      this.codeEditorProps = null;
      this.previewPaneProps = null;
      this.subtitlePanelProps = null;
      this.onTick = null;
    },
  };
});

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof ReactRouterDom>("react-router-dom");
  return {
    ...actual,
    useParams: () => ({ id: replayPageMock.routeId }),
    useSearchParams: () => [new URLSearchParams(replayPageMock.search), vi.fn()],
  };
});

vi.mock("@/features/editor/CodeEditor", () => ({
  CodeEditor: (props: CodeEditorProps) => {
    replayPageMock.codeEditorProps = props;
    return <div aria-label="Mock code editor" />;
  },
}));

vi.mock("@/features/runtime-preview/PreviewPane", () => ({
  PreviewPane: (props: PreviewPaneProps) => {
    replayPageMock.previewPaneProps = props;
    return <div aria-label="Mock preview pane" />;
  },
}));

vi.mock("@/features/subtitles", () => ({
  SubtitlePanel: (props: SubtitlePanelProps) => {
    replayPageMock.subtitlePanelProps = props;
    return <div aria-label="Mock subtitle panel" />;
  },
}));

vi.mock("@/features/runtime-preview/iframeRuntime", () => ({
  createIframeRuntime: vi.fn(() => ({})),
}));

vi.mock("@/features/library/recordingStore", () => ({
  createRecordingStore: vi.fn(() => replayPageMock.repository),
}));

vi.mock("@/features/cloud/cloudRecordingRepository", () => ({
  createCloudRecordingRepository: replayPageMock.createCloudRecordingRepository,
}));

vi.mock("../cloudPackageLoader", () => ({
  createCloudPackageLoader: replayPageMock.createCloudPackageLoader,
}));

vi.mock("../replayScheduler", () => ({
  createReplayScheduler: vi.fn((options: { onTick?: (state: ReplayStableState, events?: RecordingEvent[], timelineTimeMs?: number) => void }) => {
    replayPageMock.onTick = options.onTick ?? null;
    return replayPageMock.scheduler;
  }),
  defaultTickStrategy: vi.fn(() => ({})),
}));

vi.mock("../ReplayControls", () => ({
  ReplayControls: (props: ReplayControlsProps) => {
    replayPageMock.controlsProps = props;
    return <div aria-label="Mock replay controls" />;
  },
}));

describe("ReplayPage", () => {
  beforeEach(() => {
    replayPageMock.reset();
  });

  it("loads cloud replays through the cloud package loader when source is cloud", async () => {
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage source="cloud" />);

    await waitFor(() => expect(replayPageMock.cloudLoader.load).toHaveBeenCalledWith("recording-1"));
    expect(replayPageMock.createCloudRecordingRepository).toHaveBeenCalledTimes(1);
    expect(replayPageMock.createCloudPackageLoader).toHaveBeenCalledWith({
      repository: replayPageMock.cloudRepository,
    });
    expect(replayPageMock.repository.load).not.toHaveBeenCalled();
    expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData);
  });

  it("keeps local replays on IndexedDB by default", async () => {
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage />);

    await waitFor(() => expect(replayPageMock.repository.load).toHaveBeenCalledWith("recording-1"));
    expect(replayPageMock.cloudLoader.load).not.toHaveBeenCalled();
    expect(replayPageMock.createCloudRecordingRepository).not.toHaveBeenCalled();
  });

  it("shows the event-only notice for cloud replays with missing media", async () => {
    replayPageMock.cloudLoader.load.mockResolvedValueOnce({
      ok: true,
      package: replayPageMock.packageData,
      mediaBlob: null,
      warnings: [{ code: "media-missing", blobId: "cloud-media" }],
    });
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage source="cloud" />);

    await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));
    expect(screen.getByText("音视频不可用，已切换为纯事件流回放")).toBeInTheDocument();
  });

  it("seeks to the cloud replay timestamp from the query string after loading", async () => {
    replayPageMock.search = "?t=42000";
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage source="cloud" />);

    await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));
    await waitFor(() => expect(replayPageMock.scheduler.seek).toHaveBeenCalledWith(42_000));
  });

  it("blocks cloud replay when the cloud loader fails", async () => {
    replayPageMock.cloudLoader.load.mockResolvedValueOnce({
      ok: false,
      error: { code: "invalid-manifest", message: "descriptor failed" },
    });
    const { ReplayPage } = await import("../ReplayPage");
    const { MemoryRouter } = await import("react-router-dom");

    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <ReplayPage source="cloud" />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/加载失败：invalid-manifest/)).toBeInTheDocument());
    expect(replayPageMock.scheduler.load).not.toHaveBeenCalled();
  });

  it("wires replay control callbacks to scheduler commands", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const { ReplayPage } = await import("../ReplayPage");

    try {
      render(<ReplayPage />);

      await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));
      expect(replayPageMock.controlsProps?.durationMs).toBe(120_000);

      await act(async () => {
        await replayPageMock.controlsProps?.onSeek(42_000);
      });
      act(() => {
        replayPageMock.controlsProps?.onPlayPause();
        replayPageMock.controlsProps?.onRate(1.5);
        replayPageMock.controlsProps?.onVolume(35);
        replayPageMock.controlsProps?.onMuted(true);
      });

      expect(replayPageMock.scheduler.seek).toHaveBeenCalledWith(42_000);
      expect(replayPageMock.scheduler.play).toHaveBeenCalledTimes(1);
      expect(replayPageMock.scheduler.setRate).toHaveBeenCalledWith(1.5);
      expect(replayPageMock.scheduler.setVolume).toHaveBeenCalledWith(35);
      expect(replayPageMock.scheduler.setMuted).toHaveBeenCalledWith(true);
      await waitFor(() => expect(replayPageMock.controlsProps?.volume).toBe(35));
      expect(replayPageMock.controlsProps?.muted).toBe(true);
    } finally {
      play.mockRestore();
      pause.mockRestore();
    }
  });

  it("renders scheduler stable state into the read-only editor and runtime panel", async () => {
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage />);
    await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));

    act(() => {
      replayPageMock.onTick?.({
        editor: {
          code: "console.log('replayed');",
          language: "typescript",
          cursor: { lineNumber: 1, column: 8 },
          selection: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: 1,
            endColumn: 8,
          },
          scrollTop: 88,
          scrollLeft: 4,
          fontSize: 16,
          theme: "light",
        },
        pointer: null,
        media: { microphoneEnabled: false, cameraEnabled: false, cameraPosition: { x: 0, y: 0 } },
        runtime: {
          status: "error",
          stdout: ["hello"],
          stderr: ["warn"],
          previewHtml: "<main>preview</main>",
          errorMessage: "boom",
        },
      });
    });

    expect(replayPageMock.codeEditorProps).toEqual(
      expect.objectContaining({
        language: "typescript",
        value: "console.log('replayed');",
        readOnly: true,
        cursor: { lineNumber: 1, column: 8 },
        selection: {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 8,
        },
        scrollTop: 88,
        scrollLeft: 4,
        fontSize: 16,
        theme: "light",
      }),
    );
    expect(replayPageMock.previewPaneProps?.previewHtml).toBe("<main>preview</main>");
    expect(document.body).toHaveTextContent("hello");
    expect(document.body).toHaveTextContent("warn");
    expect(document.body).toHaveTextContent("boom");
  });

  it("wires replay subtitles to media, current timeline time, and scheduler seek", async () => {
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage />);
    await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));

    expect(screen.getByLabelText("Mock subtitle panel")).toBeInTheDocument();
    expect(replayPageMock.subtitlePanelProps).toEqual(
      expect.objectContaining({
        recordingId: "recording-1",
        hasAudio: true,
        durationMs: 120_000,
        currentTimeMs: 0,
      }),
    );
    expect(replayPageMock.subtitlePanelProps?.mediaBlob).toBeInstanceOf(Blob);

    act(() => {
      replayPageMock.onTick?.({
        editor: {
          code: "const [count, setCount] = useState(0);",
          language: "typescript",
          cursor: null,
          selection: null,
          scrollTop: 0,
          scrollLeft: 0,
          fontSize: 14,
          theme: "dark",
        },
        pointer: null,
        media: { microphoneEnabled: true, cameraEnabled: true, cameraPosition: { x: 0, y: 0 } },
        runtime: {
          status: "error",
          stdout: ["render start"],
          stderr: ["ReferenceError: count"],
          previewHtml: null,
          errorMessage: "boom",
        },
      });
    });

    expect(replayPageMock.subtitlePanelProps?.postProcessorContext).toEqual(
      expect.objectContaining({
        language: "typescript",
        code: "const [count, setCount] = useState(0);",
        runtimeOutput: "render start\nReferenceError: count\nboom",
        glossary: expect.arrayContaining(["React", "TypeScript", "code-tape"]),
      }),
    );

    await act(async () => {
      replayPageMock.subtitlePanelProps?.onSeek(2_400);
    });

    expect(replayPageMock.scheduler.seek).toHaveBeenCalledWith(2_400);
  });

  it("keeps the replay work area shrinkable so subtitles cannot push controls offscreen", async () => {
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage />);
    await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));

    expect(screen.getByLabelText("回放工作区")).toHaveClass("min-h-0");
  });

  it("renders transient pointer and shortcut overlays from scheduler ticks", async () => {
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage />);
    await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));

    act(() => {
      replayPageMock.onTick?.(
        {
          editor: {
            code: "",
            language: "javascript",
            cursor: null,
            selection: null,
            scrollTop: 0,
            scrollLeft: 0,
            fontSize: 14,
            theme: "dark",
          },
          pointer: null,
          media: { microphoneEnabled: true, cameraEnabled: true, cameraPosition: { x: 0.8, y: 0.75 } },
          runtime: { status: "idle", stdout: [], stderr: [], previewHtml: null, errorMessage: null },
        },
        [
          {
            id: "move-1",
            seq: 1,
            timestampMs: 100,
            source: "pointer",
            track: "ui",
            type: "mouse-move",
            payload: { x: 50, y: 20, containerWidth: 100, containerHeight: 80 },
          },
          {
            id: "shortcut-1",
            seq: 2,
            timestampMs: 120,
            source: "shortcut",
            track: "ui",
            type: "shortcut",
            payload: { keys: ["Cmd", "/"], label: "Comment", command: "comment" },
          },
        ],
        120,
      );
    });

    expect(screen.getByLabelText("回放鼠标位置")).toBeInTheDocument();
    expect(screen.getByLabelText("回放快捷键")).toHaveTextContent("Comment");
    expect(screen.getByText("Comment")).toBeInTheDocument();
  });

  it("keeps click pulse when a later pointer move arrives in the same scheduler tick", async () => {
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage />);
    await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));

    act(() => {
      replayPageMock.onTick?.(
        {
          editor: {
            code: "",
            language: "javascript",
            cursor: null,
            selection: null,
            scrollTop: 0,
            scrollLeft: 0,
            fontSize: 14,
            theme: "dark",
          },
          pointer: null,
          media: { microphoneEnabled: true, cameraEnabled: true, cameraPosition: { x: 0.8, y: 0.75 } },
          runtime: { status: "idle", stdout: [], stderr: [], previewHtml: null, errorMessage: null },
        },
        [
          {
            id: "click-1",
            seq: 1,
            timestampMs: 100,
            source: "pointer",
            track: "ui",
            type: "mouse-click",
            payload: { x: 30, y: 16, containerWidth: 100, containerHeight: 80, button: 0 },
          },
          {
            id: "move-2",
            seq: 2,
            timestampMs: 120,
            source: "pointer",
            track: "ui",
            type: "mouse-move",
            payload: { x: 70, y: 40, containerWidth: 100, containerHeight: 80 },
          },
        ],
        120,
      );
    });

    const pointer = screen.getByLabelText("回放鼠标位置");
    expect(pointer).toHaveStyle({ left: "70%", top: "50%" });
    expect(pointer.querySelector(".animate-ping")).toBeInTheDocument();
  });

  it("keeps the latest pointer position after the click pulse expires", async () => {
    const { ReplayPage } = await import("../ReplayPage");

    try {
      render(<ReplayPage />);
      await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));

      vi.useFakeTimers();
      act(() => {
        replayPageMock.onTick?.(
          {
            editor: {
              code: "",
              language: "javascript",
              cursor: null,
              selection: null,
              scrollTop: 0,
              scrollLeft: 0,
              fontSize: 14,
              theme: "dark",
            },
            pointer: null,
            media: { microphoneEnabled: true, cameraEnabled: true, cameraPosition: { x: 0.8, y: 0.75 } },
            runtime: { status: "idle", stdout: [], stderr: [], previewHtml: null, errorMessage: null },
          },
          [
            {
              id: "click-ttl",
              seq: 1,
              timestampMs: 100,
              source: "pointer",
              track: "ui",
              type: "mouse-click",
              payload: { x: 30, y: 16, containerWidth: 100, containerHeight: 80, button: 0 },
            },
          ],
          100,
        );
      });

      const pointer = screen.getByLabelText("回放鼠标位置");
      expect(pointer).toHaveStyle({ left: "30%", top: "20%" });
      expect(pointer.querySelector(".animate-ping")).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(901);
      });

      const retainedPointer = screen.getByLabelText("回放鼠标位置");
      expect(retainedPointer).toHaveStyle({ left: "30%", top: "20%" });
      expect(retainedPointer.querySelector(".animate-ping")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults display toggles on and hides replay layers when toggled off", async () => {
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage />);
    await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));

    const pointerToggle = screen.getByRole("button", { name: "显示鼠标轨迹" });
    const shortcutToggle = screen.getByRole("button", { name: "显示快捷键" });
    const cameraToggle = screen.getByRole("button", { name: "显示摄像头" });
    const runtimeToggle = screen.getByRole("button", { name: "显示运行面板" });
    const subtitleToggle = screen.getByRole("button", { name: "显示字幕" });

    expect(pointerToggle).toHaveAttribute("aria-pressed", "true");
    expect(shortcutToggle).toHaveAttribute("aria-pressed", "true");
    expect(cameraToggle).toHaveAttribute("aria-pressed", "true");
    expect(runtimeToggle).toHaveAttribute("aria-pressed", "true");
    expect(subtitleToggle).toHaveAttribute("aria-pressed", "true");

    act(() => {
      replayPageMock.onTick?.(
        {
          editor: {
            code: "",
            language: "javascript",
            cursor: null,
            selection: null,
            scrollTop: 0,
            scrollLeft: 0,
            fontSize: 14,
            theme: "dark",
          },
          pointer: null,
          media: { microphoneEnabled: true, cameraEnabled: true, cameraPosition: { x: 0.8, y: 0.75 } },
          runtime: {
            status: "success",
            stdout: ["ok"],
            stderr: [],
            previewHtml: "<main>preview</main>",
            errorMessage: null,
          },
        },
        [
          {
            id: "move-2",
            seq: 1,
            timestampMs: 100,
            source: "pointer",
            track: "ui",
            type: "mouse-move",
            payload: { x: 40, y: 30, containerWidth: 200, containerHeight: 100 },
          },
          {
            id: "shortcut-2",
            seq: 2,
            timestampMs: 120,
            source: "shortcut",
            track: "ui",
            type: "shortcut",
            payload: { keys: ["Meta", "S"], label: "Cmd+S" },
          },
        ],
        120,
      );
    });

    expect(screen.getByLabelText("回放鼠标位置")).toBeInTheDocument();
    expect(screen.getByText("Cmd+S")).toBeInTheDocument();
    expect(screen.getByLabelText("Mock preview pane")).toBeInTheDocument();
    expect(screen.getByLabelText("Mock subtitle panel")).toBeInTheDocument();

    fireEvent.click(pointerToggle);
    fireEvent.click(shortcutToggle);
    fireEvent.click(runtimeToggle);
    fireEvent.click(subtitleToggle);

    expect(screen.queryByLabelText("回放鼠标位置")).not.toBeInTheDocument();
    expect(screen.queryByText("Cmd+S")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Mock preview pane")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Mock subtitle panel")).not.toBeInTheDocument();
    expect(pointerToggle).toHaveAttribute("aria-pressed", "false");
    expect(shortcutToggle).toHaveAttribute("aria-pressed", "false");
    expect(runtimeToggle).toHaveAttribute("aria-pressed", "false");
    expect(subtitleToggle).toHaveAttribute("aria-pressed", "false");
  });

  it("renders recorded camera media when the package has a camera track", async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    if (typeof URL.createObjectURL !== "function") {
      Object.defineProperty(URL, "createObjectURL", {
        writable: true,
        value: vi.fn(() => "blob:replay-media"),
      });
    }
    if (typeof URL.revokeObjectURL !== "function") {
      Object.defineProperty(URL, "revokeObjectURL", {
        writable: true,
        value: vi.fn(),
      });
    }
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:replay-media");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage />);
    await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));

    act(() => {
      replayPageMock.onTick?.({
        editor: {
          code: "",
          language: "javascript",
          cursor: null,
          selection: null,
          scrollTop: 0,
          scrollLeft: 0,
          fontSize: 14,
          theme: "dark",
        },
        pointer: null,
        media: { microphoneEnabled: true, cameraEnabled: true, cameraPosition: { x: 0.8, y: 0.75 } },
        runtime: { status: "idle", stdout: [], stderr: [], previewHtml: null, errorMessage: null },
      });
    });

    const video = screen.getByLabelText("录制摄像头视频") as HTMLVideoElement;
    expect(video).toHaveAttribute("src", "blob:replay-media");
    expect(createObjectURL).toHaveBeenCalled();
    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
    pause.mockRestore();
  });

  it("attaches a media adapter before loading a package with a media blob", async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage />);

    await waitFor(() =>
      expect(replayPageMock.scheduler.setMediaAdapter.mock.calls.some(([adapter]) => adapter)).toBe(
        true,
      ),
    );
    await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));
    const firstAdapterCallIndex = replayPageMock.scheduler.setMediaAdapter.mock.calls.findIndex(
      ([adapter]) => adapter,
    );
    const adapterAttachOrder =
      replayPageMock.scheduler.setMediaAdapter.mock.invocationCallOrder[firstAdapterCallIndex];
    const loadOrder = replayPageMock.scheduler.load.mock.invocationCallOrder[0];

    expect(adapterAttachOrder).toBeLessThan(loadOrder);
    pause.mockRestore();
  });

  it("maps recording media offset as a media-time offset on the shared timeline", async () => {
    const originalMedia = replayPageMock.packageData.media;
    replayPageMock.packageData.media = {
      ...originalMedia!,
      durationMs: 120_000,
      timelineOffsetMs: 5_000,
    };
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const { ReplayPage } = await import("../ReplayPage");

    try {
      render(<ReplayPage />);

      await waitFor(() =>
        expect(replayPageMock.scheduler.setMediaAdapter.mock.calls.some(([adapter]) => adapter)).toBe(
          true,
        ),
      );
      const adapter = replayPageMock.scheduler.setMediaAdapter.mock.calls.find(
        ([candidate]) => candidate,
      )?.[0] as MediaClockAdapter | undefined;

      expect(adapter?.segments[0]).toEqual({
        blobId: "blob-1",
        timelineStartMs: 0,
        timelineEndMs: 115_000,
        mediaStartMs: 5_000,
        mediaEndMs: 120_000,
      });
      expect(adapter?.timelineToMediaTime(42_000)).toBe(47_000);
      expect(adapter?.mediaToTimelineTime(47)).toBe(42_000);
    } finally {
      replayPageMock.packageData.media = originalMedia;
      pause.mockRestore();
    }
  });

  it("keeps the scheduler subscription alive when the replay id changes", async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const { ReplayPage } = await import("../ReplayPage");

    const { rerender } = render(<ReplayPage />);
    await waitFor(() => expect(replayPageMock.repository.load).toHaveBeenCalledWith("recording-1"));

    replayPageMock.routeId = "recording-2";
    rerender(<ReplayPage />);

    await waitFor(() => expect(replayPageMock.repository.load).toHaveBeenCalledWith("recording-2"));
    expect(replayPageMock.scheduler.destroy).not.toHaveBeenCalled();
    expect(replayPageMock.scheduler.subscribe).toHaveBeenCalledTimes(1);
    pause.mockRestore();
  });

  it("shows a non-blocking notice when media is missing but the event stream loads", async () => {
    replayPageMock.repository.load.mockResolvedValueOnce({
      ok: true,
      package: replayPageMock.packageData,
      mediaBlob: null,
      warnings: [{ code: "media-missing", blobId: "blob-1" }],
    });
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage />);

    await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));
    expect(screen.getByText("音视频不可用，已切换为纯事件流回放")).toBeInTheDocument();
    expect(screen.queryByText(/加载失败/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Mock code editor")).toBeInTheDocument();
    expect(screen.getByLabelText("Mock replay controls")).toBeInTheDocument();
  });

  it("blocks replay when media checksum mismatches", async () => {
    replayPageMock.repository.load.mockResolvedValueOnce({
      ok: false,
      error: { code: "checksum-mismatch", target: "media" },
    });
    const { ReplayPage } = await import("../ReplayPage");
    const { MemoryRouter } = await import("react-router-dom");

    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <ReplayPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/加载失败：checksum-mismatch/)).toBeInTheDocument());
    expect(replayPageMock.scheduler.load).not.toHaveBeenCalled();
    expect(screen.queryByText("音视频不可用，已切换为纯事件流回放")).not.toBeInTheDocument();
  });

  it.each([
    ["invalid-manifest", { code: "invalid-manifest" as const, message: "manifest missing" }],
    ["unsupported-schema", { code: "unsupported-schema" as const, schemaVersion: "9.9.9" }],
  ])("blocks replay when package load fails with %s", async (expectedCode, error) => {
    replayPageMock.repository.load.mockResolvedValueOnce({
      ok: false,
      error,
    });
    const { ReplayPage } = await import("../ReplayPage");
    const { MemoryRouter } = await import("react-router-dom");

    render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <ReplayPage />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByText(new RegExp(`加载失败：${expectedCode}`))).toBeInTheDocument(),
    );
    expect(replayPageMock.scheduler.load).not.toHaveBeenCalled();
    expect(screen.queryByText("音视频不可用，已切换为纯事件流回放")).not.toBeInTheDocument();
  });

  it("keeps replay controls usable in event-only mode when media is missing", async () => {
    replayPageMock.repository.load.mockResolvedValueOnce({
      ok: true,
      package: replayPageMock.packageData,
      mediaBlob: null,
      warnings: [{ code: "media-missing", blobId: "blob-1" }],
    });
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage />);

    await waitFor(() => expect(replayPageMock.controlsProps).not.toBeNull());

    await act(async () => {
      await replayPageMock.controlsProps?.onSeek(10_000);
    });
    act(() => {
      replayPageMock.controlsProps?.onPlayPause();
      replayPageMock.controlsProps?.onRate(2);
    });

    expect(replayPageMock.scheduler.seek).toHaveBeenCalledWith(10_000);
    expect(replayPageMock.scheduler.play).toHaveBeenCalled();
    expect(replayPageMock.scheduler.setRate).toHaveBeenCalledWith(2);
  });

  it("clears a load error when navigating to another replay id", async () => {
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    replayPageMock.repository.load.mockResolvedValueOnce({
      ok: false,
      error: { code: "invalid-manifest", message: "missing package" },
    });
    const { ReplayPage } = await import("../ReplayPage");
    const { MemoryRouter } = await import("react-router-dom");

    const { rerender } = render(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <ReplayPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText(/加载失败：invalid-manifest/)).toBeInTheDocument());
    replayPageMock.routeId = "recording-2";
    rerender(
      <MemoryRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <ReplayPage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(replayPageMock.repository.load).toHaveBeenCalledWith("recording-2"));
    await waitFor(() => expect(screen.queryByText(/加载失败/)).not.toBeInTheDocument());
    expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData);
    pause.mockRestore();
  });

  it("starts recorded media from the replay control gesture", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    if (typeof URL.createObjectURL !== "function") {
      Object.defineProperty(URL, "createObjectURL", {
        writable: true,
        value: vi.fn(() => "blob:replay-media"),
      });
    }
    if (typeof URL.revokeObjectURL !== "function") {
      Object.defineProperty(URL, "revokeObjectURL", {
        writable: true,
        value: vi.fn(),
      });
    }
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:replay-media");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage />);
    await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));

    act(() => {
      replayPageMock.onTick?.({
        editor: {
          code: "",
          language: "javascript",
          cursor: null,
          selection: null,
          scrollTop: 0,
          scrollLeft: 0,
          fontSize: 14,
          theme: "dark",
        },
        pointer: null,
        media: { microphoneEnabled: true, cameraEnabled: true, cameraPosition: { x: 0.8, y: 0.75 } },
        runtime: { status: "idle", stdout: [], stderr: [], previewHtml: null, errorMessage: null },
      });
    });

    await waitFor(() => expect(screen.getByLabelText("录制摄像头视频")).toBeInTheDocument());
    act(() => {
      replayPageMock.controlsProps?.onPlayPause();
    });

    expect(play).toHaveBeenCalledTimes(1);
    expect(replayPageMock.scheduler.play).toHaveBeenCalledTimes(1);

    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
    play.mockRestore();
    pause.mockRestore();
  });

  it("pauses replay from the control gesture while buffering", async () => {
    replayPageMock.schedulerState.status = "buffering";
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage />);
    await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));

    act(() => {
      replayPageMock.controlsProps?.onPlayPause();
    });

    expect(replayPageMock.scheduler.pause).toHaveBeenCalledTimes(1);
    expect(replayPageMock.scheduler.play).not.toHaveBeenCalled();

    play.mockRestore();
    pause.mockRestore();
  });

  it.each([1_000, 7_000])(
    "does not start recorded media from the replay control gesture outside the active segment at %ims",
    async (timelineTimeMs) => {
      const originalMedia = replayPageMock.packageData.media;
      replayPageMock.packageData.media = {
        ...originalMedia!,
        timelineOffsetMs: 5_000,
        durationMs: 1_000,
      };
      replayPageMock.schedulerState.timelineTimeMs = timelineTimeMs;
      const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      if (typeof URL.createObjectURL !== "function") {
        Object.defineProperty(URL, "createObjectURL", {
          writable: true,
          value: vi.fn(() => "blob:replay-media"),
        });
      }
      if (typeof URL.revokeObjectURL !== "function") {
        Object.defineProperty(URL, "revokeObjectURL", {
          writable: true,
          value: vi.fn(),
        });
      }
      const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:offset-media");
      const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
      const { ReplayPage } = await import("../ReplayPage");

      try {
        render(<ReplayPage />);
        await waitFor(() => expect(screen.getByLabelText("录制摄像头视频")).toBeInTheDocument());

        act(() => {
          replayPageMock.controlsProps?.onPlayPause();
        });

        expect(play).not.toHaveBeenCalled();
        expect(pause).toHaveBeenCalled();
        expect(replayPageMock.scheduler.play).toHaveBeenCalledTimes(1);
      } finally {
        replayPageMock.packageData.media = originalMedia;
        createObjectURL.mockRestore();
        revokeObjectURL.mockRestore();
        play.mockRestore();
        pause.mockRestore();
      }
    },
  );

  it("starts recorded media when the video becomes ready after scheduler playback has begun", async () => {
    replayPageMock.schedulerState.status = "playing";
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    if (typeof URL.createObjectURL !== "function") {
      Object.defineProperty(URL, "createObjectURL", {
        writable: true,
        value: vi.fn(() => "blob:replay-media"),
      });
    }
    if (typeof URL.revokeObjectURL !== "function") {
      Object.defineProperty(URL, "revokeObjectURL", {
        writable: true,
        value: vi.fn(),
      });
    }
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:late-media");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage />);

    await waitFor(() => expect(screen.getByLabelText("录制摄像头视频")).toBeInTheDocument());
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData);

    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
    play.mockRestore();
    pause.mockRestore();
  });

  it.each([1_000, 7_000])(
    "pauses and hides recorded media outside the active media segment at %ims",
    async (timelineTimeMs) => {
      const originalMedia = replayPageMock.packageData.media;
      replayPageMock.packageData.media = {
        ...originalMedia!,
        timelineOffsetMs: 5_000,
        durationMs: 1_000,
      };
      replayPageMock.schedulerState.status = "playing";
      replayPageMock.schedulerState.timelineTimeMs = timelineTimeMs;
      const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
      const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
      if (typeof URL.createObjectURL !== "function") {
        Object.defineProperty(URL, "createObjectURL", {
          writable: true,
          value: vi.fn(() => "blob:replay-media"),
        });
      }
      if (typeof URL.revokeObjectURL !== "function") {
        Object.defineProperty(URL, "revokeObjectURL", {
          writable: true,
          value: vi.fn(),
        });
      }
      const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:offset-media");
      const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
      const { ReplayPage } = await import("../ReplayPage");

      try {
        render(<ReplayPage />);
        await waitFor(() => expect(replayPageMock.scheduler.load).toHaveBeenCalledWith(replayPageMock.packageData));

        act(() => {
          replayPageMock.onTick?.({
            editor: {
              code: "",
              language: "javascript",
              cursor: null,
              selection: null,
              scrollTop: 0,
              scrollLeft: 0,
              fontSize: 14,
              theme: "dark",
            },
            pointer: null,
            media: { microphoneEnabled: true, cameraEnabled: true, cameraPosition: { x: 0.8, y: 0.75 } },
            runtime: { status: "idle", stdout: [], stderr: [], previewHtml: null, errorMessage: null },
          });
        });

        const video = screen.getByLabelText("录制摄像头视频");
        await waitFor(() => expect(pause).toHaveBeenCalled());
        expect(play).not.toHaveBeenCalled();
        expect(video.parentElement).toHaveClass("sr-only");
      } finally {
        replayPageMock.packageData.media = originalMedia;
        createObjectURL.mockRestore();
        revokeObjectURL.mockRestore();
        play.mockRestore();
        pause.mockRestore();
      }
    },
  );
});
