import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createRecordingClock } from "./recordingClock";
import { createEventBus } from "./eventBus";
import { createPackageBuilder } from "./packageBuilder";
import { createRecordingController } from "./recordingController";
import { RecorderControls } from "./RecorderControls";
import { CodeEditor, type CodeEditorHandle } from "@/features/editor/CodeEditor";
import { CameraPreview } from "@/features/media/CameraPreview";
import { PreviewPane } from "@/features/runtime-preview/PreviewPane";
import { createPreviewCompiler } from "@/features/runtime-preview/previewCompiler";
import { createIframeRuntime } from "@/features/runtime-preview/iframeRuntime";
import { createMediaDevicesController } from "@/features/media/mediaDevices";
import { createRecordingStore } from "@/features/library/recordingStore";
import {
  createEditorProducer,
  createMediaProducer,
  createPointerProducer,
  createRuntimeProducer,
  createShortcutProducer,
} from "@/features/capture";
import type {
  CameraPositionPayload,
  RecordingControllerState,
  RecordingLanguage,
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

const APP_VERSION = "0.0.0";

/**
 * RecorderPage — wires the recording core (clock + bus + producers + builder
 * + repository + media + runtime) and renders the workshop layout.
 *
 * UI shell is intentionally minimal. The expressive UI (control bar, camera
 * dragging, shortcut badges, run/output panel) is delegated to issues. This
 * page guarantees the *infrastructure* is correctly wired so those issues can
 * focus on visual + interaction polish.
 */
export function RecorderPage() {
  const navigate = useNavigate();
  const editorRef = useRef<CodeEditorHandle | null>(null);

  const stack = useMemo(() => {
    const clock = createRecordingClock();
    const bus = createEventBus({ clock });
    const compiler = createPreviewCompiler();
    const runtime = createIframeRuntime();
    const repository = createRecordingStore();
    const devices = createMediaDevicesController();
    let currentEditorLanguage: RecordingLanguage = "javascript";
    const getCurrentRuntimeLanguage = (): RunStartPayload["language"] =>
      currentEditorLanguage === "typescript" ? "typescript" : "javascript";
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
      getHost: () => document.querySelector<HTMLElement>("[data-recorder-host]"),
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
      getCapability: () => INITIAL_CONTROLLER_STATE.mediaCapability,
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
      snapshotSource: () => editorProducer.takeSnapshot(),
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
      getCurrentEditorLanguage: () => currentEditorLanguage,
      getCurrentRuntimeLanguage,
    };
  }, []);

  const [controllerState, setControllerState] = useState<RecordingControllerState>(
    INITIAL_CONTROLLER_STATE,
  );
  const [microphoneEnabled, setMicrophoneEnabled] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [cameraPosition, setCameraPosition] = useState<CameraPositionPayload>(
    INITIAL_CAMERA_POSITION,
  );

  useEffect(() => stack.controller.subscribe(setControllerState), [stack.controller]);

  const handleStart = async () => {
    const payload: RecordStartPayload = {
      initialLanguage: stack.getCurrentEditorLanguage(),
      initialFontSize: 14,
      initialTheme: "dark",
      selectedAudioDeviceId: null,
      selectedCameraDeviceId: null,
      mediaCapability: {
        audio: "unsupported",
        camera: "unsupported",
        selectedAudioDeviceId: null,
        selectedCameraDeviceId: null,
      },
    };
    await stack.controller.start(payload);
  };
  const handleStop = async () => {
    const pkg = await stack.controller.stop("user");
    navigate(`/replay/${pkg.meta.id}`);
  };
  const handleRun = async () => {
    const editor = editorRef.current?.getEditor();
    if (!editor) return;
    stack.editorProducer.flushPending();
    await stack.runtimeProducer.trigger({
      language: stack.getCurrentRuntimeLanguage(),
      source: editor.getValue(),
    });
  };

  return (
    <div className="flex h-full flex-col" data-recorder-host>
      <RecorderControls
        state={controllerState}
        microphoneEnabled={microphoneEnabled}
        cameraEnabled={cameraEnabled}
        onStart={handleStart}
        onPause={() => stack.controller.pause()}
        onResume={() => void stack.controller.resume()}
        onStop={handleStop}
        onToggleMicrophone={(next) => {
          setMicrophoneEnabled(next);
          stack.mediaProducer.setMicrophoneEnabled(next);
        }}
        onToggleCamera={(next) => {
          setCameraEnabled(next);
          stack.mediaProducer.setCameraEnabled(next);
        }}
        onRun={handleRun}
      />
      <div className="grid flex-1 grid-cols-1 md:grid-cols-[1fr_minmax(320px,420px)]">
        <div className="relative border-r border-border">
          <CodeEditor
            ref={editorRef}
            language="javascript"
            initialValue=""
            fontSize={14}
            theme="dark"
          />
          <CameraPreview
            stream={null}
            enabled={cameraEnabled}
            position={cameraPosition}
            draggable
            onPositionChange={(next) => {
              setCameraPosition(next);
              stack.mediaProducer.reportCameraPosition(next);
            }}
          />
        </div>
        <PreviewPane runtime={stack.runtime} />
      </div>
    </div>
  );
}
