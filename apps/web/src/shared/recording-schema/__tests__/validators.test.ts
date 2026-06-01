import { describe, expect, it } from "vitest";
import {
  assertEventSeqInvariants,
  isRecordingPackageV1,
  migrateRecordingPackage,
  RECORDING_SCHEMA_VERSION,
  validateRecordingPackageV1,
  type EventBus,
  type OpenStreamRequest,
  type RecordingEvent,
  type RecordingPackageV1,
} from "@/shared/recording-schema";

function makePackage(): RecordingPackageV1 {
  return {
    schemaVersion: RECORDING_SCHEMA_VERSION,
    manifest: {
      packageId: "pkg-1",
      schemaVersion: RECORDING_SCHEMA_VERSION,
      status: "complete",
      createdAt: "2026-05-24T00:00:00.000Z",
      completedAt: "2026-05-24T00:01:00.000Z",
      checksums: { eventsSha256: "e", snapshotsSha256: "s" },
    },
    meta: {
      id: "rec-1",
      title: "Two Sum 讲解",
      createdAt: "2026-05-24T00:00:00.000Z",
      durationMs: 60_000,
      appVersion: "0.0.0",
      ownerId: null,
      creatorInfo: { displayName: "ceilf6", source: "local" },
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
    events: [],
    snapshots: [],
    media: null,
  };
}

describe("validateRecordingPackageV1", () => {
  it("accepts a minimal complete package", () => {
    const result = validateRecordingPackageV1(makePackage());
    expect(result.ok).toBe(true);
  });

  it.each(["javascript", "typescript", "python", "html", "css"] as const)(
    "accepts initialLanguage %s",
    (language) => {
      const pkg = makePackage();
      pkg.meta.initialLanguage = language;
      const result = validateRecordingPackageV1(pkg);
      expect(result.ok).toBe(true);
    },
  );

  it("rejects an unknown initialLanguage", () => {
    const pkg = makePackage();
    (pkg.meta as { initialLanguage: string }).initialLanguage = "rust";
    const result = validateRecordingPackageV1(pkg);
    expect(result.ok).toBe(false);
  });

  it("rejects malformed initial editor document view state", () => {
    const pkg = makePackage();
    const initialDocuments = makeInitialDocuments();
    initialDocuments.javascript.cursor = {} as never;
    initialDocuments.html.selection = {
      startLineNumber: "1",
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 1,
    } as never;
    pkg.meta.initialDocuments = initialDocuments;
    pkg.events = [
      {
        id: "e-1",
        seq: 1,
        timestampMs: 0,
        source: "recorder",
        track: "main",
        type: "record-start",
        payload: {
          initialLanguage: "javascript",
          initialDocuments,
          initialTheme: "dark",
          initialFontSize: 14,
          selectedAudioDeviceId: null,
          selectedCameraDeviceId: null,
          mediaCapability: pkg.meta.mediaCapability,
        },
      },
    ];

    const result = validateRecordingPackageV1(pkg);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.path)).toEqual(
        expect.arrayContaining([
          "meta.initialDocuments.javascript.cursor.lineNumber",
          "meta.initialDocuments.html.selection.startLineNumber",
          "events[0].payload.initialDocuments.javascript.cursor.lineNumber",
          "events[0].payload.initialDocuments.html.selection.startLineNumber",
        ]),
      );
    }
  });

  it("rejects non-object inputs", () => {
    const result = validateRecordingPackageV1("not a package");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].path).toBe("$");
    }
  });

  it("flags unsupported schemaVersion", () => {
    const pkg = makePackage();
    const result = validateRecordingPackageV1({ ...pkg, schemaVersion: "9.9.9" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "schemaVersion")).toBe(true);
    }
  });

  it("flags missing meta fields with field paths", () => {
    const pkg = makePackage() as unknown as Record<string, unknown>;
    const broken = { ...pkg, meta: { ...(pkg.meta as Record<string, unknown>), title: 42 } };
    const result = validateRecordingPackageV1(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "meta.title")).toBe(true);
    }
  });

  it("flags malformed events with their index", () => {
    const pkg = makePackage() as unknown as Record<string, unknown>;
    const broken = { ...pkg, events: [{ id: "x" }] };
    const result = validateRecordingPackageV1(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path.startsWith("events[0]"))).toBe(true);
    }
  });

  it("rejects duplicate and out-of-order event seq values", () => {
    const pkg = makePackage();
    const first = mockContentChangeEvent(1);
    const duplicate = mockContentChangeEvent(1);
    const outOfOrder = mockContentChangeEvent(0);

    const duplicateResult = validateRecordingPackageV1({
      ...pkg,
      events: [first, duplicate],
    });
    const orderResult = validateRecordingPackageV1({
      ...pkg,
      events: [first, outOfOrder],
    });

    expect(duplicateResult.ok).toBe(false);
    expect(orderResult.ok).toBe(false);
  });

  it("rejects invalid event source, track, and known payload shape", () => {
    const pkg = makePackage();
    const event = mockContentChangeEvent(1);
    const result = validateRecordingPackageV1({
      ...pkg,
      events: [
        {
          ...event,
          source: "browser",
          track: "screen",
          payload: { fileId: "main" },
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "events[0].source")).toBe(true);
      expect(result.errors.some((e) => e.path === "events[0].track")).toBe(true);
      expect(result.errors.some((e) => e.path === "events[0].payload.code")).toBe(true);
    }
  });

  it("accepts unsupported media-warning codes", () => {
    const pkg = makePackage();
    const result = validateRecordingPackageV1({
      ...pkg,
      events: [
        {
          id: "e-1",
          seq: 1,
          timestampMs: 100,
          source: "media",
          track: "media",
          type: "media-warning",
          payload: {
            target: "camera",
            code: "unsupported",
            message: "Camera is unsupported",
          },
        },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it("isRecordingPackageV1 narrows the type", () => {
    const input: unknown = makePackage();
    expect(isRecordingPackageV1(input)).toBe(true);
  });
});

describe("assertEventSeqInvariants", () => {
  function mockEvent(seq: number): RecordingEvent {
    return mockContentChangeEvent(seq);
  }

  it("accepts monotonic unique seq", () => {
    const result = assertEventSeqInvariants([mockEvent(1), mockEvent(2), mockEvent(3)]);
    expect(result.ok).toBe(true);
  });

  it("rejects duplicate seq", () => {
    const result = assertEventSeqInvariants([mockEvent(1), mockEvent(1)]);
    expect(result.ok).toBe(false);
  });

  it("rejects out-of-order seq", () => {
    const result = assertEventSeqInvariants([mockEvent(2), mockEvent(1)]);
    expect(result.ok).toBe(false);
  });
});

describe("EventBus contract", () => {
  it("exposes a global lastSeq accessor for snapshot alignment after drain", () => {
    const busContract: Pick<EventBus, "lastSeq"> = {
      lastSeq: () => 12,
    };

    expect(busContract.lastSeq()).toBe(12);
  });
});

describe("OpenStreamRequest contract", () => {
  it("distinguishes default devices, exact devices, and explicitly disabled tracks", () => {
    const defaultDevices = {} satisfies OpenStreamRequest;
    const exactAudio = { audioDeviceId: "mic-1" } satisfies OpenStreamRequest;
    const eventOnly = { audioDeviceId: null, cameraDeviceId: null } satisfies OpenStreamRequest;

    expect("audioDeviceId" in defaultDevices).toBe(false);
    expect(exactAudio).toEqual({ audioDeviceId: "mic-1" });
    expect(eventOnly).toEqual({ audioDeviceId: null, cameraDeviceId: null });
  });
});

function mockContentChangeEvent(seq: number): RecordingEvent {
  return {
    id: `e-${seq}`,
    seq,
    timestampMs: seq * 100,
    source: "editor",
    track: "main",
    type: "content-change",
    payload: {
      fileId: "main",
      version: seq,
      code: "",
      contentHash: "",
      language: "javascript",
      changeReason: "input",
      changeCount: 1,
      flushedBy: "debounce",
    },
  };
}

function makeInitialDocuments(): NonNullable<RecordingPackageV1["meta"]["initialDocuments"]> {
  const languages = ["javascript", "typescript", "python", "html", "css"] as const;
  return languages.reduce((documents, language) => {
    documents[language] = {
      code: "",
      cursor: null,
      selection: null,
      scrollTop: 0,
      scrollLeft: 0,
    };
    return documents;
  }, {} as NonNullable<RecordingPackageV1["meta"]["initialDocuments"]>);
}

describe("migrateRecordingPackage", () => {
  it("passes through already-current packages", () => {
    const result = migrateRecordingPackage(makePackage());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.appliedMigrations).toEqual([]);
  });

  it("returns unsupported-schema for unknown source version", () => {
    const result = migrateRecordingPackage({ ...makePackage(), schemaVersion: "9.9.9" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported-schema");
  });

  it("returns invalid-manifest when schemaVersion missing", () => {
    const result = migrateRecordingPackage({ no: "version" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid-manifest");
  });
});
