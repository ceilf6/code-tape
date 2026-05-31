import {
  RECORDING_SCHEMA_VERSION,
  type RecordingEvent,
  type RecordingEventType,
  type RecordingPackageV1,
  type SchemaValidationIssue,
  type SchemaValidationResult,
} from "./types.js";

const EVENT_TYPES = new Set<RecordingEventType>([
  "record-start",
  "record-pause",
  "record-resume",
  "resume-baseline",
  "record-stop",
  "content-change",
  "language-change",
  "selection-change",
  "editor-scroll",
  "mouse-move",
  "mouse-click",
  "shortcut",
  "media-toggle",
  "media-warning",
  "camera-position",
  "run-start",
  "run-output",
  "run-error",
  "chapter-marker",
]);
const EVENT_SOURCES = new Set([
  "recorder",
  "editor",
  "pointer",
  "shortcut",
  "media",
  "runtime",
  "annotation",
]);
const EVENT_TRACKS = new Set(["main", "media", "runtime", "ui"]);
const LANGUAGES = new Set(["javascript", "typescript", "python", "html", "css"]);

export function isKnownRecordingEventType(type: unknown): type is RecordingEventType {
  return typeof type === "string" && EVENT_TYPES.has(type as RecordingEventType);
}

/** Strongly-typed predicate so downstream code never sees `unknown` after a positive check. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pushIssue(errors: SchemaValidationIssue[], path: string, message: string): void {
  errors.push({ path, message });
}

function expectString(value: unknown, path: string, errors: SchemaValidationIssue[]): value is string {
  if (typeof value !== "string") {
    pushIssue(errors, path, `expected string, got ${typeof value}`);
    return false;
  }
  return true;
}

function expectNumber(value: unknown, path: string, errors: SchemaValidationIssue[]): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    pushIssue(errors, path, `expected finite number, got ${typeof value}`);
    return false;
  }
  return true;
}

function expectBoolean(value: unknown, path: string, errors: SchemaValidationIssue[]): value is boolean {
  if (typeof value !== "boolean") {
    pushIssue(errors, path, `expected boolean, got ${typeof value}`);
    return false;
  }
  return true;
}

function validateManifest(value: unknown, errors: SchemaValidationIssue[]): void {
  if (!isPlainObject(value)) {
    pushIssue(errors, "manifest", "manifest must be an object");
    return;
  }
  expectString(value.packageId, "manifest.packageId", errors);
  if (value.schemaVersion !== RECORDING_SCHEMA_VERSION) {
    pushIssue(errors, "manifest.schemaVersion", `unsupported schema version: ${String(value.schemaVersion)}`);
  }
  if (value.status !== "draft" && value.status !== "complete") {
    pushIssue(errors, "manifest.status", "status must be draft or complete");
  }
  expectString(value.createdAt, "manifest.createdAt", errors);
  if (value.completedAt !== null && typeof value.completedAt !== "string") {
    pushIssue(errors, "manifest.completedAt", "completedAt must be string or null");
  }
  if (!isPlainObject(value.checksums)) {
    pushIssue(errors, "manifest.checksums", "checksums must be an object");
  } else {
    expectString(value.checksums.eventsSha256, "manifest.checksums.eventsSha256", errors);
    expectString(value.checksums.snapshotsSha256, "manifest.checksums.snapshotsSha256", errors);
  }
}

function validateMeta(value: unknown, errors: SchemaValidationIssue[]): void {
  if (!isPlainObject(value)) {
    pushIssue(errors, "meta", "meta must be an object");
    return;
  }
  expectString(value.id, "meta.id", errors);
  expectString(value.title, "meta.title", errors);
  expectString(value.createdAt, "meta.createdAt", errors);
  expectNumber(value.durationMs, "meta.durationMs", errors);
  expectString(value.appVersion, "meta.appVersion", errors);
  if (value.ownerId !== null && typeof value.ownerId !== "string") {
    pushIssue(errors, "meta.ownerId", "ownerId must be string or null");
  }
  if (typeof value.initialLanguage !== "string" || !LANGUAGES.has(value.initialLanguage)) {
    pushIssue(
      errors,
      "meta.initialLanguage",
      "initialLanguage must be one of javascript|typescript|python|html|css",
    );
  }
  expectNumber(value.initialFontSize, "meta.initialFontSize", errors);
  if (value.initialTheme !== "light" && value.initialTheme !== "dark") {
    pushIssue(errors, "meta.initialTheme", "initialTheme must be light or dark");
  }
  if (!isPlainObject(value.mediaCapability)) {
    pushIssue(errors, "meta.mediaCapability", "mediaCapability must be an object");
  }
}

function validateEvent(value: unknown, index: number, errors: SchemaValidationIssue[]): void {
  const prefix = `events[${index}]`;
  if (!isPlainObject(value)) {
    pushIssue(errors, prefix, "event must be an object");
    return;
  }
  expectString(value.id, `${prefix}.id`, errors);
  expectNumber(value.seq, `${prefix}.seq`, errors);
  expectNumber(value.timestampMs, `${prefix}.timestampMs`, errors);
  if (!expectString(value.source, `${prefix}.source`, errors) || !EVENT_SOURCES.has(value.source)) {
    pushIssue(errors, `${prefix}.source`, `invalid source: ${String(value.source)}`);
  }
  if (!expectString(value.track, `${prefix}.track`, errors) || !EVENT_TRACKS.has(value.track)) {
    pushIssue(errors, `${prefix}.track`, `invalid track: ${String(value.track)}`);
  }
  const eventType = value.type;
  if (!expectString(eventType, `${prefix}.type`, errors)) return;
  const knownType = isKnownRecordingEventType(eventType);
  if (!("payload" in value)) {
    pushIssue(errors, `${prefix}.payload`, "payload is required");
  } else if (knownType) {
    validateEventPayload(eventType, value.payload, `${prefix}.payload`, errors);
  }
}

function validateEventPayload(
  type: RecordingEventType,
  payload: unknown,
  path: string,
  errors: SchemaValidationIssue[],
): void {
  if (!isPlainObject(payload)) {
    pushIssue(errors, path, "payload must be an object");
    return;
  }
  switch (type) {
    case "record-start":
      expectLanguage(payload.initialLanguage, `${path}.initialLanguage`, errors);
      expectTheme(payload.initialTheme, `${path}.initialTheme`, errors);
      expectNumber(payload.initialFontSize, `${path}.initialFontSize`, errors);
      expectNullableString(payload.selectedAudioDeviceId, `${path}.selectedAudioDeviceId`, errors);
      expectNullableString(payload.selectedCameraDeviceId, `${path}.selectedCameraDeviceId`, errors);
      if (!isPlainObject(payload.mediaCapability)) pushIssue(errors, `${path}.mediaCapability`, "mediaCapability must be an object");
      break;
    case "record-pause":
      expectLiteral(payload.reason, "user", `${path}.reason`, errors);
      expectNumber(payload.stateSeq, `${path}.stateSeq`, errors);
      break;
    case "record-resume":
      expectLiteral(payload.reason, "user", `${path}.reason`, errors);
      break;
    case "record-stop":
      expectOneOf(payload.reason, ["user", "error"], `${path}.reason`, errors);
      expectNumber(payload.durationMs, `${path}.durationMs`, errors);
      break;
    case "resume-baseline":
      if (!isPlainObject(payload.snapshot)) pushIssue(errors, `${path}.snapshot`, "snapshot must be an object");
      expectLiteral(payload.reason, "paused-state-changed", `${path}.reason`, errors);
      break;
    case "content-change":
      expectLiteral(payload.fileId, "main", `${path}.fileId`, errors);
      expectNumber(payload.version, `${path}.version`, errors);
      expectString(payload.code, `${path}.code`, errors);
      expectString(payload.contentHash, `${path}.contentHash`, errors);
      expectLanguage(payload.language, `${path}.language`, errors);
      expectOneOf(payload.changeReason, ["input", "paste", "format", "undo", "redo", "programmatic"], `${path}.changeReason`, errors);
      expectNumber(payload.changeCount, `${path}.changeCount`, errors);
      expectOneOf(payload.flushedBy, ["debounce", "idle", "paste", "format", "undo", "redo", "run", "pause", "stop", "snapshot"], `${path}.flushedBy`, errors);
      break;
    case "language-change":
      expectLanguage(payload.from, `${path}.from`, errors);
      expectLanguage(payload.to, `${path}.to`, errors);
      break;
    case "selection-change":
      expectNullableObject(payload.cursor, `${path}.cursor`, errors);
      expectNullableObject(payload.selection, `${path}.selection`, errors);
      break;
    case "editor-scroll":
      expectNumber(payload.scrollTop, `${path}.scrollTop`, errors);
      expectNumber(payload.scrollLeft, `${path}.scrollLeft`, errors);
      break;
    case "mouse-move":
      validatePointerPayload(payload, path, errors);
      break;
    case "mouse-click":
      validatePointerPayload(payload, path, errors);
      expectOneOf(payload.button, [0, 1, 2], `${path}.button`, errors);
      break;
    case "shortcut":
      expectStringArray(payload.keys, `${path}.keys`, errors);
      expectString(payload.label, `${path}.label`, errors);
      if ("command" in payload && typeof payload.command !== "undefined") expectString(payload.command, `${path}.command`, errors);
      break;
    case "media-toggle":
      expectBoolean(payload.microphoneEnabled, `${path}.microphoneEnabled`, errors);
      expectBoolean(payload.cameraEnabled, `${path}.cameraEnabled`, errors);
      break;
    case "media-warning":
      expectOneOf(payload.target, ["audio", "camera", "recorder"], `${path}.target`, errors);
      expectOneOf(payload.code, ["permission-denied", "not-found", "busy", "unsupported", "track-ended", "recorder-error"], `${path}.code`, errors);
      expectString(payload.message, `${path}.message`, errors);
      break;
    case "camera-position":
      expectNumber(payload.x, `${path}.x`, errors);
      expectNumber(payload.y, `${path}.y`, errors);
      break;
    case "run-start":
      expectOneOf(payload.language, ["javascript", "typescript", "html", "css"], `${path}.language`, errors);
      expectLiteral(payload.runtime, "iframe", `${path}.runtime`, errors);
      expectString(payload.runId, `${path}.runId`, errors);
      break;
    case "run-output":
      expectString(payload.runId, `${path}.runId`, errors);
      expectStringArray(payload.stdout, `${path}.stdout`, errors);
      expectStringArray(payload.stderr, `${path}.stderr`, errors);
      expectNullableString(payload.previewHtml, `${path}.previewHtml`, errors);
      expectLiteral(payload.status, "success", `${path}.status`, errors);
      break;
    case "run-error":
      expectString(payload.runId, `${path}.runId`, errors);
      expectOneOf(payload.phase, ["transpile", "runtime"], `${path}.phase`, errors);
      expectString(payload.message, `${path}.message`, errors);
      expectStringArray(payload.stdout, `${path}.stdout`, errors);
      expectStringArray(payload.stderr, `${path}.stderr`, errors);
      expectNullableString(payload.previewHtml, `${path}.previewHtml`, errors);
      break;
    case "chapter-marker":
      expectString(payload.title, `${path}.title`, errors);
      break;
  }
}

function validatePointerPayload(payload: Record<string, unknown>, path: string, errors: SchemaValidationIssue[]): void {
  expectNumber(payload.x, `${path}.x`, errors);
  expectNumber(payload.y, `${path}.y`, errors);
  expectNumber(payload.containerWidth, `${path}.containerWidth`, errors);
  expectNumber(payload.containerHeight, `${path}.containerHeight`, errors);
}

function expectNullableString(value: unknown, path: string, errors: SchemaValidationIssue[]): void {
  if (value !== null && typeof value !== "string") pushIssue(errors, path, "expected string or null");
}

function expectNullableObject(value: unknown, path: string, errors: SchemaValidationIssue[]): void {
  if (value !== null && !isPlainObject(value)) pushIssue(errors, path, "expected object or null");
}

function expectStringArray(value: unknown, path: string, errors: SchemaValidationIssue[]): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    pushIssue(errors, path, "expected string array");
  }
}

function expectLanguage(value: unknown, path: string, errors: SchemaValidationIssue[]): void {
  if (typeof value !== "string" || !LANGUAGES.has(value)) pushIssue(errors, path, "invalid language");
}

function expectTheme(value: unknown, path: string, errors: SchemaValidationIssue[]): void {
  if (value !== "light" && value !== "dark") pushIssue(errors, path, "invalid theme");
}

function expectLiteral<T extends string | number>(value: unknown, expected: T, path: string, errors: SchemaValidationIssue[]): void {
  if (value !== expected) pushIssue(errors, path, `expected ${String(expected)}`);
}

function expectOneOf<T extends string | number>(value: unknown, allowed: readonly T[], path: string, errors: SchemaValidationIssue[]): void {
  if (!allowed.includes(value as T)) pushIssue(errors, path, `expected one of ${allowed.join("|")}`);
}

function validateSnapshot(value: unknown, index: number, errors: SchemaValidationIssue[]): void {
  const prefix = `snapshots[${index}]`;
  if (!isPlainObject(value)) {
    pushIssue(errors, prefix, "snapshot must be an object");
    return;
  }
  expectString(value.id, `${prefix}.id`, errors);
  expectNumber(value.timestampMs, `${prefix}.timestampMs`, errors);
  expectNumber(value.eventSeq, `${prefix}.eventSeq`, errors);
  if (!isPlainObject(value.state)) {
    pushIssue(errors, `${prefix}.state`, "state must be an object");
  }
}

function validateMedia(value: unknown, errors: SchemaValidationIssue[]): void {
  if (value === null) return;
  if (!isPlainObject(value)) {
    pushIssue(errors, "media", "media must be object or null");
    return;
  }
  expectString(value.blobId, "media.blobId", errors);
  expectString(value.mimeType, "media.mimeType", errors);
  expectNumber(value.durationMs, "media.durationMs", errors);
  expectNumber(value.sizeBytes, "media.sizeBytes", errors);
  expectNumber(value.timelineOffsetMs, "media.timelineOffsetMs", errors);
  expectBoolean(value.hasAudio, "media.hasAudio", errors);
  expectBoolean(value.hasCamera, "media.hasCamera", errors);
}

/**
 * Validate that a value matches RecordingPackageV1.
 *
 * Intentionally implemented without zod / arktype to keep dependency surface small.
 * The check is shape-based: any unknown nested keys are tolerated so future minor
 * extensions don't break old loaders, but every required field is enforced.
 */
export function validateRecordingPackageV1(input: unknown): SchemaValidationResult {
  const errors: SchemaValidationIssue[] = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: "$", message: "package must be an object" }] };
  }
  if (input.schemaVersion !== RECORDING_SCHEMA_VERSION) {
    errors.push({
      path: "schemaVersion",
      message: `unsupported schemaVersion: ${String(input.schemaVersion)}`,
    });
  }
  validateManifest(input.manifest, errors);
  validateMeta(input.meta, errors);

  if (!Array.isArray(input.events)) {
    errors.push({ path: "events", message: "events must be an array" });
  } else {
    input.events.forEach((event, idx) => validateEvent(event, idx, errors));
    if (errors.length === 0) {
      const seqResult = assertEventSeqInvariants(input.events as RecordingEvent[]);
      if (!seqResult.ok) errors.push(...seqResult.errors);
    }
  }

  if (!Array.isArray(input.snapshots)) {
    errors.push({ path: "snapshots", message: "snapshots must be an array" });
  } else {
    input.snapshots.forEach((snapshot, idx) => validateSnapshot(snapshot, idx, errors));
  }

  validateMedia(input.media, errors);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

/** Convenience type guard for already-validated inputs. */
export function isRecordingPackageV1(input: unknown): input is RecordingPackageV1 {
  return validateRecordingPackageV1(input).ok;
}

/** Returns a deterministic event ordering invariant: every `seq` is unique and monotonic. */
export function assertEventSeqInvariants(events: RecordingEvent[]): SchemaValidationResult {
  const seen = new Set<number>();
  const errors: SchemaValidationIssue[] = [];
  let last = 0;
  events.forEach((event, idx) => {
    if (seen.has(event.seq)) {
      errors.push({ path: `events[${idx}].seq`, message: `duplicate seq: ${event.seq}` });
    }
    seen.add(event.seq);
    if (event.seq <= last && idx > 0) {
      errors.push({ path: `events[${idx}].seq`, message: `seq must be monotonic: ${event.seq} after ${last}` });
    }
    last = Math.max(last, event.seq);
  });
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
