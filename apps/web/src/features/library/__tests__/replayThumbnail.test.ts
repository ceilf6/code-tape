import { afterEach, describe, expect, it, vi } from "vitest";
import { RECORDING_SCHEMA_VERSION, type RecordingPackageV1 } from "@/shared/recording-schema";
import { createReplayThumbnail } from "../replayThumbnail";
import { DEFAULT_VIDEO_THUMBNAIL_OPTIONS } from "../videoThumbnail";

describe("createReplayThumbnail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("draws the final replay state instead of depending on a raw media frame", async () => {
    const fillText = vi.fn();
    const context = {
      fillStyle: "",
      font: "",
      textBaseline: "",
      fillRect: vi.fn(),
      fillText,
      measureText: vi.fn((text: string) => ({ width: text.length * 7 })),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      quadraticCurveTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toBlob: vi.fn((callback: BlobCallback) => callback(new Blob(["thumbnail"], { type: "image/webp" }))),
    };
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
      if (tagName === "canvas") return canvas as unknown as HTMLCanvasElement;
      return originalCreateElement(tagName, options);
    });

    const thumbnail = await createReplayThumbnail(makePackageWithFinalCode(), DEFAULT_VIDEO_THUMBNAIL_OPTIONS);

    expect(thumbnail).toBeInstanceOf(Blob);
    expect(thumbnail?.type).toBe("image/webp");
    expect(fillText.mock.calls.some(([text]) => String(text).startsWith("console.log('final"))).toBe(true);
  });
});

function makePackageWithFinalCode(): RecordingPackageV1 {
  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    manifest: {
      packageId: "pkg-1",
      schemaVersion: RECORDING_SCHEMA_VERSION,
      status: "complete",
      createdAt: "2026-06-01T00:00:00.000Z",
      completedAt: "2026-06-01T00:01:00.000Z",
      checksums: { eventsSha256: "events", snapshotsSha256: "snapshots" },
    },
    meta: {
      id: "rec-1",
      title: "Final frame",
      createdAt: "2026-06-01T00:00:00.000Z",
      durationMs: 10_000,
      appVersion: "test",
      ownerId: null,
      creatorInfo: null,
      initialLanguage: "javascript",
      initialFontSize: 14,
      initialTheme: "dark",
      mediaCapability: {
        audio: "available",
        camera: "available",
        selectedAudioDeviceId: null,
        selectedCameraDeviceId: null,
      },
    },
    events: [
      {
        id: "edit-final",
        seq: 1,
        timestampMs: 9_000,
        source: "editor",
        track: "main",
        type: "content-change",
        payload: {
          fileId: "main",
          version: 1,
          code: "console.log('final frame');",
          contentHash: "final",
          language: "javascript",
          changeReason: "input",
          changeCount: 1,
          flushedBy: "debounce",
        },
      },
    ],
    snapshots: [],
    media: null,
  };
}
