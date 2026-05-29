import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import {
  Activity,
  CircleDot,
  Mic,
  MicOff,
  Monitor,
  Radio,
  SignalHigh,
  UserRound,
  Video,
  VideoOff,
} from "lucide-react";
import { CodeEditor } from "@/features/editor/CodeEditor";
import { Toggle, Tooltip } from "@/shared/ui";
import {
  createInterviewMediaSession,
  type InterviewEventsDataChannel,
  type InterviewMediaSession,
  type InterviewMediaSessionState,
} from "./interviewMediaSession";
import { createInterviewRealtimeReceiver } from "./interviewRealtimeReceiver";
import { INITIAL_REMOTE_INTERVIEW_STABLE_STATE } from "./remoteInterviewInitialState";
import {
  createRemoteInterviewWorkbench,
  type RemoteInterviewWorkbenchState,
} from "./remoteInterviewWorkbench";

export type RemoteInterviewWorkbenchViewProps = {
  roomId: string;
  workbenchState: RemoteInterviewWorkbenchState;
  mediaState: InterviewMediaSessionState;
};

export type RemoteInterviewWorkbenchPageProps = {
  deps?: {
    createMediaSession?: () => InterviewMediaSession;
  };
};

type RemoteInterviewWorkbenchRoomProps = {
  roomId: string;
  deps: NonNullable<RemoteInterviewWorkbenchPageProps["deps"]>;
};

const EMPTY_INTERVIEW_MEDIA_SESSION_STATE: InterviewMediaSessionState = {
  localStream: null,
  remoteStream: null,
  microphoneEnabled: false,
  cameraEnabled: false,
  connectionState: "new",
  iceConnectionState: "new",
  signalingState: "stable",
  outgoingIceCandidates: [],
  eventsDataChannelState: "not-created",
};

export function RemoteInterviewWorkbenchPage({
  deps = {},
}: RemoteInterviewWorkbenchPageProps = {}) {
  const { roomId = "unknown" } = useParams();

  return <RemoteInterviewWorkbenchRoom key={roomId} roomId={roomId} deps={deps} />;
}

function RemoteInterviewWorkbenchRoom({ roomId, deps }: RemoteInterviewWorkbenchRoomProps) {
  const createMediaSession = deps.createMediaSession ?? createInterviewMediaSession;
  const workbench = useMemo(
    () => createRemoteInterviewWorkbench({ initialState: INITIAL_REMOTE_INTERVIEW_STABLE_STATE }),
    [],
  );
  const receiver = useMemo(
    () => createInterviewRealtimeReceiver({ roomId, workbench }),
    [roomId, workbench],
  );
  const [workbenchState, setWorkbenchState] = useState(() => workbench.getState());
  const [mediaSession, setMediaSession] = useState<InterviewMediaSession | null>(null);
  const [mediaState, setMediaState] = useState<InterviewMediaSessionState>(
    emptyInterviewMediaSessionState,
  );

  useEffect(() => workbench.subscribe(setWorkbenchState), [workbench]);
  useEffect(() => {
    const nextMediaSession = safeCreateMediaSession(createMediaSession);
    setMediaSession(nextMediaSession);
    setMediaState(nextMediaSession?.getState() ?? emptyInterviewMediaSessionState());

    return () => {
      nextMediaSession?.close();
    };
  }, [createMediaSession]);
  useEffect(() => {
    if (!mediaSession) {
      return undefined;
    }

    let attachedChannel: InterviewEventsDataChannel | null = null;
    let detachReceiver: (() => void) | null = null;
    const refreshReceiver = () => {
      const nextChannel = receivableEventsDataChannel(mediaSession.getEventsDataChannel());
      if (nextChannel === attachedChannel) {
        return;
      }
      detachReceiver?.();
      attachedChannel = nextChannel;
      detachReceiver = nextChannel ? receiver.attach(nextChannel) : null;
    };

    setMediaState(mediaSession.getState());
    refreshReceiver();
    const unsubscribe = mediaSession.subscribe((next) => {
      setMediaState(next);
      refreshReceiver();
    });

    return () => {
      unsubscribe();
      detachReceiver?.();
    };
  }, [mediaSession, receiver]);

  return (
    <RemoteInterviewWorkbenchView
      roomId={roomId}
      workbenchState={workbenchState}
      mediaState={mediaState}
    />
  );
}

function safeCreateMediaSession(
  createMediaSession: () => InterviewMediaSession,
): InterviewMediaSession | null {
  try {
    return createMediaSession();
  } catch {
    return null;
  }
}

function receivableEventsDataChannel(
  channel: InterviewEventsDataChannel | null,
): InterviewEventsDataChannel | null {
  if (!channel || channel.readyState === "closed" || channel.readyState === "closing") {
    return null;
  }
  return channel;
}

function emptyInterviewMediaSessionState(): InterviewMediaSessionState {
  return {
    ...EMPTY_INTERVIEW_MEDIA_SESSION_STATE,
    outgoingIceCandidates: [],
  };
}

export function RemoteInterviewWorkbenchView({
  roomId,
  workbenchState,
  mediaState,
}: RemoteInterviewWorkbenchViewProps) {
  const editor = workbenchState.stableState.editor;
  const sync = syncStatusView(workbenchState);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex min-h-16 flex-wrap items-center gap-3 border-b border-border bg-surface/80 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Monitor aria-hidden size={18} className="text-primary" />
            <h1 className="font-display text-base font-semibold">面试官工作台</h1>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted">
            <span>房间</span>
            <span className="max-w-[18rem] truncate font-mono text-foreground">{roomId}</span>
          </div>
        </div>
        <div
          role="status"
          aria-live="polite"
          className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${sync.toneClass}`}
        >
          <sync.Icon aria-hidden size={16} />
          <span className="font-medium">{sync.label}</span>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-label="候选人编辑器" className="flex min-h-0 flex-col border-r border-border">
          <div className="flex min-h-11 flex-wrap items-center gap-3 border-b border-border bg-background px-4 py-2 text-xs text-muted">
            <span className="font-mono uppercase tracking-normal text-foreground">
              {editor.language}
            </span>
            <span>font {editor.fontSize}px</span>
            <span>applied seq {workbenchState.lastAppliedSeq}</span>
            <span>next seq {workbenchState.expectedSeq}</span>
          </div>
          <div className="min-h-0 flex-1">
            <CodeEditor
              language={editor.language}
              initialValue={editor.code}
              value={editor.code}
              fontSize={editor.fontSize}
              theme={editor.theme}
              readOnly
              cursor={editor.cursor}
              selection={editor.selection}
              scrollTop={editor.scrollTop}
              scrollLeft={editor.scrollLeft}
            />
          </div>
        </section>

        <aside
          aria-label="实时面试侧栏"
          className="flex min-h-0 flex-col gap-4 overflow-auto bg-surface px-4 py-4"
        >
          <SyncDetailPanel state={workbenchState} label={sync.label} detail={sync.detail} />
          <InterviewMediaPanel state={mediaState} />
        </aside>
      </div>
    </div>
  );
}

function SyncDetailPanel({
  state,
  label,
  detail,
}: {
  state: RemoteInterviewWorkbenchState;
  label: string;
  detail: string;
}) {
  return (
    <section className="rounded-md border border-border bg-background p-3">
      <div className="flex items-center gap-2">
        <Activity aria-hidden size={16} className="text-primary" />
        <h2 className="text-sm font-semibold">同步状态</h2>
      </div>
      <p className="mt-3 text-sm font-medium text-foreground">{label}</p>
      <p className="mt-1 text-xs leading-5 text-muted">{detail}</p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <Metric label="已应用" value={`seq ${state.lastAppliedSeq}`} />
        <Metric label="下一个" value={`seq ${state.expectedSeq}`} />
      </dl>
    </section>
  );
}

function InterviewMediaPanel({ state }: { state: InterviewMediaSessionState }) {
  const micLabel = state.microphoneEnabled ? "麦克风已开启" : "麦克风已关闭";
  const cameraLabel = state.cameraEnabled ? "摄像头已开启" : "摄像头已关闭";

  return (
    <section className="rounded-md border border-border bg-background p-3">
      <div className="flex items-center gap-2">
        <Radio aria-hidden size={16} className="text-primary" />
        <h2 className="text-sm font-semibold">音视频</h2>
      </div>

      <div className="mt-3 grid gap-3">
        <MediaStreamTile
          title="候选人视频"
          stream={state.remoteStream}
          muted={false}
          placeholder={<UserRound aria-hidden size={28} />}
        />
        <MediaStreamTile
          title="本地预览"
          stream={state.localStream}
          muted
          placeholder={<Monitor aria-hidden size={28} />}
        />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Tooltip content={micLabel}>
          <Toggle
            pressed={state.microphoneEnabled}
            onPressedChange={() => {}}
            disabled
            label={micLabel}
            icon={<MicOff size={17} />}
            iconPressed={<Mic size={17} />}
          />
        </Tooltip>
        <Tooltip content={cameraLabel}>
          <Toggle
            pressed={state.cameraEnabled}
            onPressedChange={() => {}}
            disabled
            label={cameraLabel}
            icon={<VideoOff size={17} />}
            iconPressed={<Video size={17} />}
          />
        </Tooltip>
        <span className="ml-auto text-xs text-muted">{state.signalingState}</span>
      </div>

      <dl className="mt-3 grid gap-2 text-xs">
        <Metric label="WebRTC" value={state.connectionState} />
        <Metric label="ICE" value={state.iceConnectionState} />
        <Metric label="事件通道" value={state.eventsDataChannelState} />
      </dl>
    </section>
  );
}

function MediaStreamTile({
  title,
  stream,
  muted,
  placeholder,
}: {
  title: string;
  stream: MediaStream | null;
  muted: boolean;
  placeholder: ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  return (
    <figure className="overflow-hidden rounded-md border border-border bg-surface-raised">
      <div className="aspect-video bg-surface">
        {stream ? (
          <video
            ref={videoRef}
            aria-label={`${title}画面`}
            className="h-full w-full object-cover"
            autoPlay
            muted={muted}
            playsInline
          />
        ) : (
          <div
            role="img"
            aria-label={`${title}占位`}
            className="flex h-full w-full items-center justify-center text-muted"
          >
            {placeholder}
          </div>
        )}
      </div>
      <figcaption className="flex items-center justify-between px-3 py-2 text-xs">
        <span className="font-medium text-foreground">{title}</span>
        <span className="text-muted">{stream ? "已绑定" : "等待媒体"}</span>
      </figcaption>
    </figure>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-surface px-2 py-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate font-mono text-foreground">{value}</dd>
    </div>
  );
}

function syncStatusView(state: RemoteInterviewWorkbenchState): {
  label: string;
  detail: string;
  toneClass: string;
  Icon: typeof CircleDot;
} {
  if (state.syncStatus === "waiting-for-snapshot") {
    return {
      label: "等待候选人状态快照",
      detail: state.snapshotRequestNeeded
        ? `缺失事件 seq ${state.snapshotRequestNeeded.expectedSeq}，已保留 seq ${state.snapshotRequestNeeded.lastAppliedSeq} 的稳定状态`
        : "正在等待候选人状态，已保留最后稳定代码",
      toneClass: "border-warning/40 bg-warning/10 text-warning",
      Icon: SignalHigh,
    };
  }
  if (state.syncStatus === "live") {
    return {
      label: "实时同步",
      detail: `已应用 seq ${state.lastAppliedSeq}，等待 seq ${state.expectedSeq}`,
      toneClass: "border-success/40 bg-success/10 text-success",
      Icon: CircleDot,
    };
  }
  return {
    label: "等待候选人",
    detail: "候选人开始发送编辑事件后会进入实时同步",
    toneClass: "border-border bg-surface text-muted",
    Icon: CircleDot,
  };
}
