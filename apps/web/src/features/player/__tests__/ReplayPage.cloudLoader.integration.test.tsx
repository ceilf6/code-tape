import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeEditorProps } from "@/features/editor/CodeEditor";
import type { PreviewPaneProps } from "@/features/runtime-preview/PreviewPane";
import type { SubtitlePanelProps } from "@/features/subtitles";
import type { CloudPlaybackDescriptor } from "@/features/cloud/types";
import type {
  RecordingPackageV1,
  ReplaySchedulerState,
  ReplayStableState,
} from "@/shared/recording-schema";
import { canonicalStringify, sha256Hex } from "@/shared/util/hash";
import type * as ReactRouterDom from "react-router-dom";

const replayIntegrationMock = vi.hoisted(() => {
  const schedulerState: ReplaySchedulerState = {
    status: "ready",
    timelineTimeMs: 0,
    playbackRate: 1,
    lastAppliedSeq: 0,
    mediaStatus: "none",
    driftMs: 0,
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
    subscribe: vi.fn((listener: (state: ReplaySchedulerState) => void) => {
      listener(schedulerState);
      return vi.fn();
    }),
  };
  const descriptorRepository = {
    getPlaybackDescriptor: vi.fn(),
  };
  const localRepository = {
    load: vi.fn(),
  };
  return {
    scheduler,
    descriptorRepository,
    localRepository,
    routeId: "cloud-rec-1",
    search: "",
    reset() {
      scheduler.load.mockClear();
      scheduler.setMediaAdapter.mockClear();
      scheduler.destroy.mockClear();
      scheduler.subscribe.mockClear();
      descriptorRepository.getPlaybackDescriptor.mockReset();
      localRepository.load.mockReset();
      this.routeId = "cloud-rec-1";
      this.search = "";
    },
  };
});

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof ReactRouterDom>("react-router-dom");
  return {
    ...actual,
    useParams: () => ({ id: replayIntegrationMock.routeId }),
    useSearchParams: () => [new URLSearchParams(replayIntegrationMock.search), vi.fn()],
  };
});

vi.mock("@/features/editor/CodeEditor", () => ({
  CodeEditor: (_props: CodeEditorProps) => <div aria-label="Mock code editor" />,
}));

vi.mock("@/features/runtime-preview/PreviewPane", () => ({
  PreviewPane: (_props: PreviewPaneProps) => <div aria-label="Mock preview pane" />,
}));

vi.mock("@/features/subtitles", () => ({
  SubtitlePanel: (_props: SubtitlePanelProps) => <div aria-label="Mock subtitle panel" />,
}));

vi.mock("@/features/runtime-preview/iframeRuntime", () => ({
  createIframeRuntime: vi.fn(() => ({})),
}));

vi.mock("@/features/library/recordingStore", () => ({
  createRecordingStore: vi.fn(() => replayIntegrationMock.localRepository),
}));

vi.mock("@/features/cloud/cloudRecordingRepository", () => ({
  createCloudRecordingRepository: vi.fn(() => replayIntegrationMock.descriptorRepository),
}));

vi.mock("../replayScheduler", () => ({
  createReplayScheduler: vi.fn((options: { onTick?: (state: ReplayStableState) => void }) => {
    options.onTick?.({
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
      media: { microphoneEnabled: false, cameraEnabled: false, cameraPosition: { x: 0, y: 0 } },
      runtime: { status: "idle", stdout: [], stderr: [], previewHtml: null, errorMessage: null },
    });
    return replayIntegrationMock.scheduler;
  }),
  defaultTickStrategy: vi.fn(() => ({})),
}));

vi.mock("../ReplayControls", () => ({
  ReplayControls: () => <div aria-label="Mock replay controls" />,
}));

describe("ReplayPage cloud package loader integration", () => {
  beforeEach(() => {
    replayIntegrationMock.reset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads cloud recordings through the real CloudPackageLoader descriptor lookup", async () => {
    const parts = await makePackageParts();
    replayIntegrationMock.descriptorRepository.getPlaybackDescriptor.mockResolvedValue({
      ok: true,
      value: makeDescriptor(),
    });
    vi.stubGlobal("fetch", makeAssetFetch({
      "https://assets.example.com/manifest.json": jsonResponse(parts.manifest),
      "https://assets.example.com/meta.json": jsonResponse(parts.meta),
      "https://assets.example.com/events.json": jsonResponse(parts.events),
      "https://assets.example.com/snapshots.json": jsonResponse(parts.snapshots),
    }));
    const { ReplayPage } = await import("../ReplayPage");

    render(<ReplayPage source="cloud" />);

    await waitFor(() => {
      expect(replayIntegrationMock.descriptorRepository.getPlaybackDescriptor).toHaveBeenCalledWith("cloud-rec-1");
    });
    await waitFor(() => {
      expect(replayIntegrationMock.scheduler.load).toHaveBeenCalledWith(
        expect.objectContaining({
          meta: expect.objectContaining({ id: "cloud-rec-1" }),
        }),
      );
    });
    expect(replayIntegrationMock.localRepository.load).not.toHaveBeenCalled();
  });
});

async function makePackageParts() {
  const events: RecordingPackageV1["events"] = [
    {
      id: "event-1",
      seq: 1,
      timestampMs: 100,
      source: "editor",
      track: "main",
      type: "content-change",
      payload: {
        fileId: "main",
        version: 1,
        code: "console.log('cloud replay');",
        contentHash: "hash-1",
        language: "javascript",
        changeReason: "input",
        changeCount: 1,
        flushedBy: "debounce",
      },
    },
  ];
  const snapshots: RecordingPackageV1["snapshots"] = [
    {
      id: "snapshot-1",
      timestampMs: 0,
      eventSeq: 1,
      state: {
        editor: {
          code: "console.log('cloud replay');",
          language: "javascript",
          cursor: null,
          selection: null,
          scrollTop: 0,
          scrollLeft: 0,
          fontSize: 14,
          theme: "dark",
        },
        pointer: null,
        media: { microphoneEnabled: false, cameraEnabled: false, cameraPosition: { x: 0, y: 0 } },
        runtime: { status: "idle", stdout: [], stderr: [], previewHtml: null, errorMessage: null },
      },
    },
  ];
  const manifest: RecordingPackageV1["manifest"] = {
    packageId: "cloud-rec-1",
    schemaVersion: "0.1.0",
    status: "complete",
    createdAt: "2026-05-29T00:00:00.000Z",
    completedAt: "2026-05-29T00:01:00.000Z",
    checksums: {
      eventsSha256: await sha256Hex(canonicalStringify(events)),
      snapshotsSha256: await sha256Hex(canonicalStringify(snapshots)),
    },
  };
  const meta: RecordingPackageV1["meta"] = {
    id: "cloud-rec-1",
    title: "Cloud Replay",
    createdAt: "2026-05-29T00:00:00.000Z",
    durationMs: 1_000,
    appVersion: "0.0.0",
    ownerId: null,
    creatorInfo: null,
    initialLanguage: "javascript",
    initialFontSize: 14,
    initialTheme: "dark",
    mediaCapability: {
      audio: "not-found",
      camera: "not-found",
      selectedAudioDeviceId: null,
      selectedCameraDeviceId: null,
    },
  };
  return { manifest, meta, events, snapshots };
}

function makeDescriptor(): CloudPlaybackDescriptor {
  return {
    id: "cloud-rec-1",
    title: "Cloud Replay",
    durationMs: 1_000,
    schemaVersion: "0.1.0",
    manifestUrl: "https://assets.example.com/manifest.json",
    metaUrl: "https://assets.example.com/meta.json",
    eventsUrl: "https://assets.example.com/events.json",
    snapshotsUrl: "https://assets.example.com/snapshots.json",
    indexesUrl: null,
    mediaUrl: null,
    thumbnailUrl: null,
    expiresAt: "2026-05-29T00:10:00.000Z",
  };
}

function makeAssetFetch(responses: Record<string, Response>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return responses[url] ?? new Response("missing test response", { status: 404, statusText: "Not Found" });
  }) as typeof fetch;
}

function jsonResponse(value: unknown): Response {
  return new Response(canonicalStringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
