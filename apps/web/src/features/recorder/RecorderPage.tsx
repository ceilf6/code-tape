import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createRecordingClock } from "./recordingClock";
import { createEventBus } from "./eventBus";
import { createPackageBuilder } from "./packageBuilder";
import { createRecordingController } from "./recordingController";
import { RecorderControls } from "./RecorderControls";
import { CodeEditor, type CodeEditorHandle } from "@/features/editor/CodeEditor";
import { CameraPreview } from "@/features/media/CameraPreview";
import { PreviewPane } from "@/features/runtime-preview/PreviewPane";
import { RuntimeOutputPanel } from "@/features/runtime-preview/RuntimeOutputPanel";
import { createPreviewCompiler } from "@/features/runtime-preview/previewCompiler";
import { createIframeRuntime } from "@/features/runtime-preview/iframeRuntime";
import { createMediaDevicesController } from "@/features/media/mediaDevices";
import { createMediaRecorderWrapper } from "@/features/media/mediaRecorder";
import { buildRecordingZip } from "@/features/library/recordingArchive";
import { downloadBlob, safeFilenameStem } from "@/features/library/recordingDownload";
import { createRecordingStore } from "@/features/library/recordingStore";
import { ShieldCheck } from "lucide-react";
import {
  createEditorProducer,
  createMediaProducer,
  createPointerProducer,
  createRuntimeProducer,
  createShortcutProducer,
} from "@/features/capture";
import { IconButton, ResizableWorkspace, useTheme } from "@/shared/ui";
import type {
  CameraPositionPayload,
  DeviceInfo,
  EventBus,
  MediaCapability,
  MediaDevicesController,
  OpenStreamResult,
  RecordingControllerState,
  RecordingControllerStatus,
  RecordingLanguage,
  PackageBuildInput,
  RecordStartPayload,
  RunStartPayload,
} from "@/shared/recording-schema";

const INITIAL_CONTROLLER_STATE: RecordingControllerState = {
  status: "idle",
  startedAt: null,
  durationMs: 0,
  mediaCapability: {
    audio: "unsupported",
    camera: "unsupported",
    selectedAudioDeviceId: null,
    selectedCameraDeviceId: null,
  },
  lastError: null,
};

const INITIAL_CAMERA_POSITION: CameraPositionPayload = { x: 0.85, y: 0.85 };
const INITIAL_RUNTIME_STATE: RecorderRuntimeState = {
  status: "idle",
  stdout: [],
  stderr: [],
  errorMessage: null,
};

const APP_VERSION = "0.0.0";
const FONT_SIZE_OPTIONS = [12, 14, 16, 18, 20] as const;
const AUTO_RUN_IDLE_MS = 2_000;
const IDLE_CLEANUP_GRACE_MS = 50;
const LIVE_DURATION_REFRESH_MS = 1000;

type DeviceOptions = {
  audio: DeviceInfo[];
  camera: DeviceInfo[];
  loaded: boolean;
};
type DeviceList = Pick<DeviceOptions, "audio" | "camera">;
type MediaOpenRequest = { audioDeviceId?: string | null; cameraDeviceId?: string | null };
type PermissionStatus = "granted" | "denied" | "not-found" | "busy";
type RecorderRuntimeState = {
  status: "idle" | "running" | "success" | "error" | "timeout";
  stdout: string[];
  stderr: string[];
  errorMessage: string | null;
};

/**
 * RecorderPage — wires the recording core (clock + bus + producers + builder
 * + repository + media + runtime) and renders the workshop layout.
 */
export type RecorderPageProps = {
  onEventBusReady?: (bus: Pick<EventBus, "peek" | "subscribe">) => (() => void) | void;
};

export function RecorderPage({ onEventBusReady }: RecorderPageProps = {}) {
  const navigate = useNavigate();
  const theme = useTheme();
  const editorRef = useRef<CodeEditorHandle | null>(null);
  const mediaRecorderRef = useRef<ReturnType<typeof createMediaRecorderWrapper> | null>(null);
  const mountedRef = useRef(true);
  const startInFlightRef = useRef(false);
  const startTokenRef = useRef(0);
  const stopTokenRef = useRef(0);
  const autoRunTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleCleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resourcesCleanedUpRef = useRef(false);
  const [mediaStream, setMediaStream] = useState<MediaStream | null>(null);
  const [persistenceNotice, setPersistenceNotice] = useState<string | null>(null);

  const stack = useMemo(() => {
    const clock = createRecordingClock();
    const bus = createEventBus({ clock });
    const compiler = createPreviewCompiler();
    const runtime = createIframeRuntime();
    const repository = createRecordingStore();
    const devices = createMediaDevicesController();
    let currentEditorLanguage: RecordingLanguage = "javascript";
    let currentMediaCapability: MediaCapability = INITIAL_CONTROLLER_STATE.mediaCapability;
    const getCurrentRuntimeLanguage = (): RunStartPayload["language"] | null => {
      switch (currentEditorLanguage) {
        case "typescript":
          return "typescript";
        case "html":
          return "html";
        case "css":
          return "css";
        case "javascript":
          return "javascript";
        case "python":
          // Python：只高亮 / 录制 / 回放，不执行（见 docs/技术方案.md 第六章）。
          return null;
      }
    };
    const editorProducer = createEditorProducer({
      bus,
      clock,
      getEditor: () => editorRef.current?.getEditor() ?? null,
      getCurrentLanguage: () => currentEditorLanguage,
      setModelLanguage: (_model, language) => {
        currentEditorLanguage = language;
        editorRef.current?.setModelLanguage(language);
      },
    });
    const pointerProducer = createPointerProducer({
      bus,
      clock,
      getHost: () => document.querySelector<HTMLElement>("[data-code-editor]"),
    });
    const shortcutProducer = createShortcutProducer({
      bus,
      clock,
      getRoot: () => window,
    });
    const mediaProducer = createMediaProducer({
      bus,
      clock,
      devices,
      getCapability: () => currentMediaCapability,
    });
    const runtimeProducer = createRuntimeProducer({ bus, clock, compiler, runtime });
    const packageBuilder = createPackageBuilder();
    const controller = createRecordingController({
      clock,
      bus,
      producers: [editorProducer, pointerProducer, shortcutProducer, mediaProducer, runtimeProducer],
      packageBuilder,
      repository,
      appVersion: APP_VERSION,
      mediaSource: async () => {
        const recorder = mediaRecorderRef.current;
        mediaRecorderRef.current = null;
        try {
          if (!recorder) return null;
          const result = await recorder.stop();
          return {
            blob: result.blob,
            durationMs: result.durationMs,
            mimeType: result.mimeType,
            hasAudio: result.hasAudio,
            hasCamera: result.hasCamera,
          } satisfies PackageBuildInput["media"];
        } catch (err) {
          console.warn("[recorder-page] media finalization failed:", err);
          return null;
        } finally {
          devices.release();
          if (mountedRef.current) setMediaStream(null);
        }
      },
      onPersistenceFailure: async ({ pkg, mediaBlob, error }) => {
        console.warn("[recorder-page] persistence failed, downloading fallback package:", error);
        const zipBlob = await buildRecordingZip(pkg, mediaBlob);
        downloadBlob(zipBlob, `${safeFilenameStem(pkg.meta.title, pkg.meta.id)}.zip`);
        if (mountedRef.current) {
          setPersistenceNotice(
            "保存未进入本地回放中心，已为你导出 ZIP 兜底文件。请保留该文件以便后续导入回放。",
          );
        }
      },
    });
    return {
      controller,
      bus,
      runtime,
      compiler,
      devices,
      editorProducer,
      mediaProducer,
      runtimeProducer,
      setCurrentMediaCapability: (capability: MediaCapability) => {
        currentMediaCapability = capability;
      },
      setCurrentEditorLanguage: (language: RecordingLanguage) => {
        currentEditorLanguage = language;
        editorRef.current?.setModelLanguage(language);
      },
      getCurrentEditorLanguage: () => currentEditorLanguage,
      getCurrentRuntimeLanguage,
      getCurrentDurationMs: () => clock.durationMs(),
    };
  }, []);

  const [controllerState, setControllerState] = useState<RecordingControllerState>(
    INITIAL_CONTROLLER_STATE,
  );
  const [displayDurationMs, setDisplayDurationMs] = useState(0);
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [editorLanguage, setEditorLanguage] = useState<RecordingLanguage>("javascript");
  const [editorFontSize, setEditorFontSize] = useState<number>(14);
  const [deviceOptions, setDeviceOptions] = useState<DeviceOptions>({
    audio: [],
    camera: [],
    loaded: false,
  });
  const deviceOptionsRef = useRef<DeviceOptions>(deviceOptions);
  const deviceLoadPromiseRef = useRef<Promise<DeviceList> | null>(null);
  const deviceLoadIdRef = useRef(0);
  const audioDeviceSelectionTouchedRef = useRef(false);
  const cameraDeviceSelectionTouchedRef = useRef(false);
  const [selectedAudioDeviceId, setSelectedAudioDeviceId] = useState<string | null>(null);
  const [selectedCameraDeviceId, setSelectedCameraDeviceId] = useState<string | null>(null);
  const [cameraPosition, setCameraPosition] = useState<CameraPositionPayload>(
    INITIAL_CAMERA_POSITION,
  );
  const [mediaPermissionNotice, setMediaPermissionNotice] = useState<string | null>(null);
  const [mediaPermissionRequesting, setMediaPermissionRequesting] = useState(false);
  const [runtimeState, setRuntimeState] = useState<RecorderRuntimeState>(INITIAL_RUNTIME_STATE);

  useEffect(() => {
    return onEventBusReady?.(stack.bus) ?? undefined;
  }, [onEventBusReady, stack.bus]);

  useEffect(() => {
    return () => {
      if (autoRunTimerRef.current) clearTimeout(autoRunTimerRef.current);
    };
  }, []);

  const loadDevices = useCallback((options: { force?: boolean } = {}) => {
    if (deviceLoadPromiseRef.current && !options.force) return deviceLoadPromiseRef.current;
    const loadId = ++deviceLoadIdRef.current;
    const promise = (async () => {
      try {
        const available = await stack.devices.enumerate();
        if (!mountedRef.current || deviceLoadIdRef.current !== loadId) return available;
        const nextOptions = { ...available, loaded: true };
        deviceOptionsRef.current = nextOptions;
        setDeviceOptions(nextOptions);
        setSelectedAudioDeviceId((current) =>
          audioDeviceSelectionTouchedRef.current ? current : available.audio[0]?.deviceId ?? null,
        );
        setSelectedCameraDeviceId((current) =>
          cameraDeviceSelectionTouchedRef.current ? current : available.camera[0]?.deviceId ?? null,
        );
        return available;
      } catch (err) {
        console.warn("[recorder-page] media devices unavailable:", err);
        stack.devices.release();
        if (mountedRef.current && deviceLoadIdRef.current === loadId) {
          const nextOptions = { audio: [], camera: [], loaded: true };
          deviceOptionsRef.current = nextOptions;
          setDeviceOptions(nextOptions);
          setSelectedAudioDeviceId(null);
          setSelectedCameraDeviceId(null);
        }
        return { audio: [], camera: [] };
      }
    })();
    deviceLoadPromiseRef.current = promise;
    void promise.finally(() => {
      if (deviceLoadPromiseRef.current === promise) {
        deviceLoadPromiseRef.current = null;
      }
    });
    return promise;
  }, [stack.devices]);

  useEffect(
    () => {
      mountedRef.current = true;
      return stack.controller.subscribe((nextState) => {
        if (mountedRef.current) setControllerState(nextState);
      });
    },
    [stack.controller],
  );
  useEffect(() => {
    if (controllerState.status !== "recording") {
      setDisplayDurationMs(controllerState.durationMs);
      return;
    }

    const refreshDuration = () => {
      setDisplayDurationMs(stack.getCurrentDurationMs());
    };

    refreshDuration();
    const timer = window.setInterval(refreshDuration, LIVE_DURATION_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [controllerState.durationMs, controllerState.status, stack]);
  useEffect(() => {
    void loadDevices();
  }, [loadDevices]);
  useEffect(
    () => {
      mountedRef.current = true;
      resourcesCleanedUpRef.current = false;
      if (idleCleanupTimerRef.current) {
        clearTimeout(idleCleanupTimerRef.current);
        idleCleanupTimerRef.current = null;
      }
      return () => {
        mountedRef.current = false;
        const wasStarting = startInFlightRef.current;
        startInFlightRef.current = false;
        startTokenRef.current += 1;
        stopTokenRef.current += 1;
        const status = stack.controller.state.status;
        const isFinalizing = isFinalizingRecordingStatus(status);
        const cleanupRecordingResources = () => {
          if (resourcesCleanedUpRef.current) return;
          resourcesCleanedUpRef.current = true;
          stack.controller.reset();
          const recorder = mediaRecorderRef.current;
          mediaRecorderRef.current = null;
          void recorder?.stop().catch((err) => {
            console.warn("[recorder-page] cleanup media stop failed:", err);
          });
          stack.devices.release();
        };
        if (status === "idle" && !wasStarting) {
          idleCleanupTimerRef.current = setTimeout(() => {
            idleCleanupTimerRef.current = null;
            cleanupRecordingResources();
          }, IDLE_CLEANUP_GRACE_MS);
        } else if (!isFinalizing) {
          cleanupRecordingResources();
        }
      };
    },
    [stack.controller, stack.devices],
  );

  const isCurrentStart = (token: number) => mountedRef.current && startTokenRef.current === token;
  const handleAudioDeviceChange = useCallback((deviceId: string | null) => {
    audioDeviceSelectionTouchedRef.current = true;
    setSelectedAudioDeviceId(deviceId);
  }, []);
  const handleCameraDeviceChange = useCallback((deviceId: string | null) => {
    cameraDeviceSelectionTouchedRef.current = true;
    setSelectedCameraDeviceId(deviceId);
  }, []);
  const handleRequestMediaPermission = useCallback(async () => {
    if (mediaPermissionRequesting || stack.controller.state.status !== "idle") return;
    setMediaPermissionRequesting(true);
    setMediaPermissionNotice("正在请求浏览器设备权限...");
    try {
      const [audio, camera] = await Promise.all([
        stack.devices.requestPermission("audio"),
        stack.devices.requestPermission("camera"),
      ]);
      await loadDevices({ force: true });
      setMediaPermissionNotice(formatPermissionNotice(audio, camera));
    } catch (err) {
      console.warn("[recorder-page] media permission request failed:", err);
      await loadDevices({ force: true });
      setMediaPermissionNotice("设备权限申请失败，可选择无媒体录制。");
    } finally {
      if (mountedRef.current) setMediaPermissionRequesting(false);
    }
  }, [loadDevices, mediaPermissionRequesting, stack.controller, stack.devices]);

  const handleStart = async () => {
    if (startInFlightRef.current) return;
    startInFlightRef.current = true;
    setPersistenceNotice(null);
    const startToken = (startTokenRef.current += 1);
    try {
      const currentDeviceOptions = deviceOptionsRef.current;
      const available = currentDeviceOptions.loaded
        ? { audio: currentDeviceOptions.audio, camera: currentDeviceOptions.camera }
        : await loadDevices();
      const audioDeviceId = audioDeviceSelectionTouchedRef.current
        ? selectedAudioDeviceId
        : selectedAudioDeviceId ?? available.audio[0]?.deviceId ?? null;
      const cameraDeviceId = cameraDeviceSelectionTouchedRef.current
        ? selectedCameraDeviceId
        : selectedCameraDeviceId ?? available.camera[0]?.deviceId ?? null;
      const explicitlyDisabledAllMedia = audioDeviceSelectionTouchedRef.current
        && cameraDeviceSelectionTouchedRef.current
        && audioDeviceId === null
        && cameraDeviceId === null;
      const shouldOpenMedia = audioDeviceId !== null || cameraDeviceId !== null || explicitlyDisabledAllMedia;
      let media = shouldOpenMedia
        ? await openSelectedMedia(stack.devices, { audioDeviceId, cameraDeviceId })
        : eventOnlyMedia();
      if (!isCurrentStart(startToken)) {
        stack.devices.release();
        return;
      }
      if (media.stream) {
        setMediaStream(media.stream);
        let recorder: ReturnType<typeof createMediaRecorderWrapper> | null = null;
        try {
          recorder = createMediaRecorderWrapper();
          mediaRecorderRef.current = recorder;
          await recorder.start(media.stream);
          if (!isCurrentStart(startToken)) {
            if (mediaRecorderRef.current === recorder) {
              mediaRecorderRef.current = null;
              await recorder.stop().catch(() => undefined);
            }
            stack.devices.release();
            return;
          }
        } catch (err) {
          console.warn("[recorder-page] media recorder start failed:", err);
          if (recorder && mediaRecorderRef.current === recorder) {
            mediaRecorderRef.current = null;
            await recorder.stop().catch((stopErr) => {
              console.warn("[recorder-page] media recorder cleanup after start failed:", stopErr);
            });
          }
          if (!isCurrentStart(startToken)) {
            stack.devices.release();
            return;
          }
          stack.devices.release();
          setMediaStream(null);
          media = eventOnlyMedia();
        }
      }
      const activeTracks = media.stream?.getTracks() ?? [];
      const hasAudioTrack = activeTracks.some((track) => track.kind === "audio");
      const hasCameraTrack = activeTracks.some((track) => track.kind === "video");
      setMicrophoneEnabled(hasAudioTrack);
      setCameraEnabled(hasCameraTrack);
      stack.setCurrentMediaCapability(media.capability);

      const payload: RecordStartPayload = {
        initialLanguage: stack.getCurrentEditorLanguage(),
        initialFontSize: editorFontSize,
        initialTheme: theme.resolved,
        selectedAudioDeviceId: media.capability.selectedAudioDeviceId,
        selectedCameraDeviceId: media.capability.selectedCameraDeviceId,
        mediaCapability: media.capability,
      };
      try {
        await stack.controller.start(payload);
        stack.mediaProducer.primeInitialState({
          microphoneEnabled: hasAudioTrack,
          cameraEnabled: hasCameraTrack,
          cameraPosition,
        });
        if (!isCurrentStart(startToken) && isActiveRecordingStatus(stack.controller.state.status)) {
          stack.controller.reset();
        }
      } catch (error) {
        const recorder = mediaRecorderRef.current;
        mediaRecorderRef.current = null;
        await recorder?.stop().catch(() => undefined);
        stack.devices.release();
        if (isCurrentStart(startToken)) {
          setMediaStream(null);
          setMicrophoneEnabled(false);
          setCameraEnabled(false);
          stack.setCurrentMediaCapability(INITIAL_CONTROLLER_STATE.mediaCapability);
        }
        throw error;
      }
    } finally {
      startInFlightRef.current = false;
    }
  };
  const handleStop = async () => {
    clearAutoRunTimer();
    const stopToken = (stopTokenRef.current += 1);
    try {
      const pkg = await stack.controller.stop("user");
      if (mountedRef.current && stopTokenRef.current === stopToken) {
        setPersistenceNotice(null);
        navigate(`/replay/${pkg.meta.id}`);
      } else {
        stack.controller.reset();
      }
    } catch (error) {
      if (mountedRef.current && stopTokenRef.current === stopToken) {
        console.warn("[recorder-page] stop failed:", error);
        await resetAfterStopFailure();
        return;
      }
      stack.controller.reset();
      console.warn("[recorder-page] stop ignored after unmount:", error);
    }
  };
  const resetAfterStopFailure = async () => {
    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    await recorder?.stop().catch((err) => {
      console.warn("[recorder-page] cleanup media stop after failure failed:", err);
    });
    stack.devices.release();
    setMediaStream(null);
    setMicrophoneEnabled(false);
    setCameraEnabled(false);
    stack.setCurrentMediaCapability(INITIAL_CONTROLLER_STATE.mediaCapability);
    stack.controller.reset();
  };
  const handlePause = () => {
    if (stack.controller.state.status !== "recording") return;
    clearAutoRunTimer();
    const recorder = mediaRecorderRef.current;
    stack.controller.pause();
    try {
      recorder?.pause();
    } catch (err) {
      console.warn("[recorder-page] media pause failed:", err);
      void stack.controller.resume().catch((rollbackErr) => {
        console.warn("[recorder-page] controller pause rollback failed:", rollbackErr);
      });
    }
  };
  const handleResume = () => {
    if (stack.controller.state.status !== "paused") return;
    const recorder = mediaRecorderRef.current;
    try {
      recorder?.resume();
    } catch (err) {
      console.warn("[recorder-page] media resume failed:", err);
      return;
    }
    void stack.controller.resume().catch((err) => {
      console.warn("[recorder-page] controller resume failed:", err);
      try {
        recorder?.pause();
      } catch (rollbackErr) {
        console.warn("[recorder-page] media resume rollback failed:", rollbackErr);
      }
    });
  };
  const clearAutoRunTimer = () => {
    if (!autoRunTimerRef.current) return;
    clearTimeout(autoRunTimerRef.current);
    autoRunTimerRef.current = null;
  };

  const isRuntimeRunLocked = () => {
    const status = stack.controller.state.status;
    return status === "paused" || status === "requestingPermission" || status === "stopping" || status === "processing";
  };

  const handleRun = async (options: { clearPendingAutoRun?: boolean } = {}) => {
    if (options.clearPendingAutoRun ?? true) clearAutoRunTimer();
    if (isRuntimeRunLocked()) return;
    const runtimeLanguage = stack.getCurrentRuntimeLanguage();
    // Python 不执行：跳过运行，保持高亮/录制/回放。
    if (runtimeLanguage === null) return;
    const editor = editorRef.current?.getEditor();
    if (!editor) return;
    stack.editorProducer.flushPending();
    setRuntimeState({ status: "running", stdout: [], stderr: [], errorMessage: null });
    try {
      const result = await stack.runtimeProducer.trigger({
        language: runtimeLanguage,
        source: editor.getValue(),
      });
      if (result.status === "complete") {
        setRuntimeState({
          status: "success",
          stdout: result.stdout,
          stderr: result.stderr,
          errorMessage: null,
        });
        return;
      }
      if (result.status === "timeout") {
        setRuntimeState({
          status: "timeout",
          stdout: result.stdout,
          stderr: result.stderr,
          errorMessage: "runtime-timeout",
        });
        return;
      }
      setRuntimeState({
        status: "error",
        stdout: result.stdout,
        stderr: result.stderr,
        errorMessage: result.message,
      });
    } catch (err) {
      setRuntimeState({
        status: "error",
        stdout: [],
        stderr: [],
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const scheduleAutoRun = () => {
    clearAutoRunTimer();
    autoRunTimerRef.current = setTimeout(() => {
      autoRunTimerRef.current = null;
      void handleRun({ clearPendingAutoRun: false });
    }, AUTO_RUN_IDLE_MS);
  };

  const handleLanguageChange = (next: RecordingLanguage) => {
    setEditorLanguage(next);
    stack.setCurrentEditorLanguage(next);
    if (stack.controller.state.status === "recording") {
      stack.editorProducer.setLanguage(next);
    }
  };
  const displayControllerState = useMemo(
    () => ({ ...controllerState, durationMs: displayDurationMs }),
    [controllerState, displayDurationMs],
  );

  return (
    <div className="flex h-full flex-col" data-recorder-host>
      <RecorderControls
        state={displayControllerState}
        microphoneEnabled={microphoneEnabled}
        cameraEnabled={cameraEnabled}
        onStart={handleStart}
        onPause={handlePause}
        onResume={handleResume}
        onStop={handleStop}
        onToggleMicrophone={(next) => {
          if (stack.controller.state.status === "paused") return;
          setMicrophoneEnabled(next);
          stack.mediaProducer.setMicrophoneEnabled(next);
        }}
        onToggleCamera={(next) => {
          if (stack.controller.state.status === "paused") return;
          setCameraEnabled(next);
          stack.mediaProducer.setCameraEnabled(next);
        }}
        onRun={handleRun}
      />
      {persistenceNotice ? (
        <div
          role="alert"
          className="border-b border-warning/40 bg-warning/10 px-4 py-2 text-sm text-foreground"
        >
          {persistenceNotice}
        </div>
      ) : null}
      <RecorderSetupToolbar
        language={editorLanguage}
        fontSize={editorFontSize}
        audioDevices={deviceOptions.audio}
        cameraDevices={deviceOptions.camera}
        selectedAudioDeviceId={selectedAudioDeviceId}
        selectedCameraDeviceId={selectedCameraDeviceId}
        permissionNotice={mediaPermissionNotice}
        permissionRequesting={mediaPermissionRequesting}
        disabled={controllerState.status !== "idle"}
        onLanguageChange={handleLanguageChange}
        onFontSizeChange={setEditorFontSize}
        onAudioDeviceChange={handleAudioDeviceChange}
        onCameraDeviceChange={handleCameraDeviceChange}
        onRequestMediaPermission={handleRequestMediaPermission}
      />
      <ResizableWorkspace
        ariaLabel="录制工作区"
        separatorLabel="调整录制工作区宽度"
        storageKey="code-tape:workspace:recorder:left-percent"
        desktopBreakpoint="lg"
        leftClassName="relative min-h-[18rem] border-b border-border lg:min-h-0 lg:border-b-0"
        rightClassName="flex flex-1 flex-col"
        left={
          <>
            <CodeEditor
              ref={editorRef}
              language={editorLanguage}
              initialValue=""
              fontSize={editorFontSize}
              theme={theme.resolved}
              minHeight="compact"
              readOnly={controllerState.status === "paused"}
              onChange={scheduleAutoRun}
              onCommand={(command) => {
                if (command === "run") void handleRun();
              }}
              onBeforeFormatApply={() => stack.editorProducer.markNextChangeAsFormat()}
            />
            <CameraPreview
              stream={mediaStream}
              enabled={cameraEnabled}
              position={cameraPosition}
              draggable={controllerState.status !== "paused"}
              onPositionChange={(next) => {
                if (stack.controller.state.status === "paused") return;
                setCameraPosition(next);
                stack.mediaProducer.reportCameraPosition(next);
              }}
            />
          </>
        }
        right={
          <ResizableWorkspace
            orientation="vertical"
            ariaLabel="录制预览与输出区"
            separatorLabel="调整录制预览与输出区高度"
            storageKey="code-tape:workspace:recorder:preview-percent"
            defaultLeftPercent={68}
            minLeftPercent={30}
            maxLeftPercent={85}
            leftClassName="flex flex-col"
            rightClassName="flex flex-col"
            left={
              <PreviewPane
                runtime={stack.runtime}
                theme={theme.resolved}
                className="min-h-0 flex-1"
                onReset={() => setRuntimeState(INITIAL_RUNTIME_STATE)}
              />
            }
            right={<RuntimeOutputPanel runtime={runtimeState} />}
          />
        }
      />
    </div>
  );
}

async function openSelectedMedia(
  devices: MediaDevicesController,
  request: MediaOpenRequest,
): Promise<OpenStreamResult> {
  try {
    const result = await devices.openStream(request);
    const requestedAnyTrack = request.audioDeviceId !== null || request.cameraDeviceId !== null;
    if (!result.stream && requestedAnyTrack) {
      devices.release();
      return result;
    }
    return result;
  } catch (err) {
    console.warn("[recorder-page] media devices unavailable:", err);
    devices.release();
    return eventOnlyMedia();
  }
}

type RecorderSetupToolbarProps = {
  language: RecordingLanguage;
  fontSize: number;
  audioDevices: DeviceInfo[];
  cameraDevices: DeviceInfo[];
  selectedAudioDeviceId: string | null;
  selectedCameraDeviceId: string | null;
  permissionNotice: string | null;
  permissionRequesting: boolean;
  disabled: boolean;
  onLanguageChange(language: RecordingLanguage): void;
  onFontSizeChange(size: number): void;
  onAudioDeviceChange(deviceId: string | null): void;
  onCameraDeviceChange(deviceId: string | null): void;
  onRequestMediaPermission(): void;
};

function RecorderSetupToolbar({
  language,
  fontSize,
  audioDevices,
  cameraDevices,
  selectedAudioDeviceId,
  selectedCameraDeviceId,
  permissionNotice,
  permissionRequesting,
  disabled,
  onLanguageChange,
  onFontSizeChange,
  onAudioDeviceChange,
  onCameraDeviceChange,
  onRequestMediaPermission,
}: RecorderSetupToolbarProps) {
  return (
    <div
      className="flex min-h-11 flex-wrap items-center gap-3 border-b border-border bg-background px-3 py-2"
      data-recorder-setup
    >
      <LabeledSelect
        label="语言"
        value={language}
        disabled={disabled}
        onChange={(value) => onLanguageChange(value as RecordingLanguage)}
        options={[
          { value: "javascript", label: "JavaScript" },
          { value: "typescript", label: "TypeScript" },
          { value: "html", label: "HTML" },
          { value: "css", label: "CSS" },
          { value: "python", label: "Python" },
        ]}
      />
      <LabeledSelect
        label="字号"
        value={String(fontSize)}
        disabled={disabled}
        onChange={(value) => onFontSizeChange(Number(value))}
        options={FONT_SIZE_OPTIONS.map((size) => ({ value: String(size), label: `${size}px` }))}
      />
      <span className="hidden h-6 w-px bg-border md:inline-flex" aria-hidden />
      <LabeledSelect
        label="麦克风设备"
        value={selectedAudioDeviceId ?? ""}
        disabled={disabled}
        onChange={(value) => onAudioDeviceChange(value || null)}
        options={[
          { value: "", label: "无麦克风" },
          ...audioDevices.map((device) => ({
            value: device.deviceId,
            label: device.label || "未命名麦克风",
          })),
        ]}
      />
      <LabeledSelect
        label="摄像头设备"
        value={selectedCameraDeviceId ?? ""}
        disabled={disabled}
        onChange={(value) => onCameraDeviceChange(value || null)}
        options={[
          { value: "", label: "无摄像头" },
          ...cameraDevices.map((device) => ({
            value: device.deviceId,
            label: device.label || "未命名摄像头",
          })),
        ]}
      />
      <IconButton
        label="申请设备权限"
        icon={<ShieldCheck size={15} />}
        size="sm"
        variant="subtle"
        disabled={disabled || permissionRequesting}
        onClick={onRequestMediaPermission}
      />
      {permissionNotice ? (
        <span role="status" aria-live="polite" className="text-xs text-muted">
          {permissionNotice}
        </span>
      ) : null}
    </div>
  );
}

type LabeledSelectProps = {
  label: string;
  value: string;
  disabled?: boolean;
  options: Array<{ value: string; label: string }>;
  onChange(value: string): void;
};

function LabeledSelect({ label, value, disabled, options, onChange }: LabeledSelectProps) {
  return (
    <label className="flex max-w-full min-w-0 items-center gap-2 text-xs text-muted">
      <span className="shrink-0">{label}</span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        className="h-8 w-44 max-w-full rounded-md border border-border bg-surface px-2 text-sm text-foreground outline-none transition-colors focus:ring-2 focus:ring-focus disabled:cursor-not-allowed disabled:opacity-50"
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option key={`${label}-${option.value}`} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function eventOnlyMedia(warnings: OpenStreamResult["warnings"] = []): OpenStreamResult {
  return {
    stream: null,
    warnings,
    capability: INITIAL_CONTROLLER_STATE.mediaCapability,
  };
}

function formatPermissionNotice(audio: PermissionStatus, camera: PermissionStatus): string {
  if (audio === "granted" && camera === "granted") return "设备权限已授权。";
  if (audio === "denied" && camera === "denied") return "麦克风和摄像头权限被拒绝，可选择无媒体录制。";
  const parts = [
    `麦克风${permissionStatusLabel(audio)}`,
    `摄像头${permissionStatusLabel(camera)}`,
  ];
  return `${parts.join("，")}。`;
}

function permissionStatusLabel(status: PermissionStatus): string {
  switch (status) {
    case "granted":
      return "已授权";
    case "denied":
      return "权限被拒绝";
    case "not-found":
      return "未找到设备";
    case "busy":
      return "设备被占用";
  }
}

function isActiveRecordingStatus(status: RecordingControllerStatus): boolean {
  return status === "requestingPermission" || status === "recording" || status === "paused";
}

function isFinalizingRecordingStatus(status: RecordingControllerStatus): boolean {
  return status === "stopping" || status === "processing";
}
