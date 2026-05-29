import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useParams } from "react-router-dom";
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
import {
  createInterviewRoomClient,
  type InterviewRoomClient,
  type InterviewRoomStatus,
} from "./interviewRoomClient";
import {
  createInterviewSignalingClient,
  type InboundSignalingMessage,
  type InterviewSignalingClient,
  type InterviewSignalingClientOptions,
} from "./interviewSignalingClient";
import { INITIAL_REMOTE_INTERVIEW_STABLE_STATE } from "./remoteInterviewInitialState";
import {
  createRemoteInterviewWorkbench,
  type RemoteInterviewWorkbenchState,
} from "./remoteInterviewWorkbench";

export type RemoteInterviewConnectionStatus =
  | "missing-join-code"
  | "checking-room"
  | "connecting"
  | "watching"
  | "ended"
  | "failed";

export type RemoteInterviewConnectionState = {
  status: RemoteInterviewConnectionStatus;
  joinCode: string | null;
  signalingUrl: string | null;
  expiresAt: string | null;
  candidateOnline: boolean;
  errorMessage: string | null;
};

export type RemoteInterviewWorkbenchViewProps = {
  roomId: string;
  workbenchState: RemoteInterviewWorkbenchState;
  mediaState: InterviewMediaSessionState;
  connectionState?: RemoteInterviewConnectionState;
};

export type RemoteInterviewWorkbenchPageProps = {
  deps?: {
    roomClient?: InterviewRoomClient;
    createSignalingClient?: (
      options: InterviewSignalingClientOptions,
    ) => InterviewSignalingClient;
    createMediaSession?: () => InterviewMediaSession;
  };
};

type RemoteInterviewWorkbenchRoomProps = {
  roomId: string;
  joinCode: string | null;
  deps: NonNullable<RemoteInterviewWorkbenchPageProps["deps"]>;
};

type InboundOfferMessage = Extract<InboundSignalingMessage, { sdp: string }> & {
  kind: "offer";
};

type InboundIceCandidateMessage = Extract<
  InboundSignalingMessage,
  { candidate: string }
>;

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
  const location = useLocation();
  const joinCode = useMemo(() => readJoinCode(location.search), [location.search]);

  return (
    <RemoteInterviewWorkbenchRoom
      key={`${roomId}:${joinCode ?? ""}`}
      roomId={roomId}
      joinCode={joinCode}
      deps={deps}
    />
  );
}

function RemoteInterviewWorkbenchRoom({
  roomId,
  joinCode,
  deps,
}: RemoteInterviewWorkbenchRoomProps) {
  const roomClient = useMemo(
    () => deps.roomClient ?? createInterviewRoomClient(),
    [deps.roomClient],
  );
  const createSignalingClient = deps.createSignalingClient ?? createInterviewSignalingClient;
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
  const [connectionState, setConnectionState] = useState<RemoteInterviewConnectionState>(() =>
    initialRemoteConnectionState(joinCode),
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
  useEffect(() => {
    if (!joinCode) {
      setConnectionState({
        status: "missing-join-code",
        joinCode: null,
        signalingUrl: null,
        expiresAt: null,
        candidateOnline: false,
        errorMessage: "缺少 joinCode，无法加入面试房间",
      });
      return undefined;
    }

    if (!mediaSession) {
      setConnectionState({
        status: "connecting",
        joinCode,
        signalingUrl: null,
        expiresAt: null,
        candidateOnline: false,
        errorMessage: null,
      });
      return undefined;
    }

    let closed = false;
    let signalingClient: InterviewSignalingClient | null = null;
    let activeCandidateConnectionId: string | null = null;
    let localMediaRequest: Promise<InterviewMediaSessionState> | null = null;
    const retiredCandidateConnectionIds = new Set<string>();
    setConnectionState({
      status: "checking-room",
      joinCode,
      signalingUrl: null,
      expiresAt: null,
      candidateOnline: false,
      errorMessage: null,
    });

    const fail = (message: string) => {
      if (closed) return;
      mediaSession.close();
      setConnectionState((current) => ({
        ...current,
        status: "failed",
        candidateOnline: false,
        errorMessage: message,
      }));
    };
    const shouldApplyCandidateMessage = (message: {
      role: "candidate" | "interviewer";
      connectionId: string;
    }) => {
      if (message.role !== "candidate") return false;
      if (retiredCandidateConnectionIds.has(message.connectionId)) return false;
      if (activeCandidateConnectionId && activeCandidateConnectionId !== message.connectionId) {
        return false;
      }
      activeCandidateConnectionId = message.connectionId;
      return true;
    };
    const ensureLocalMedia = () => {
      const current = mediaSession.getState();
      if (current.localStream) {
        return Promise.resolve(current);
      }
      if (!localMediaRequest) {
        localMediaRequest = mediaSession.requestLocalMedia().catch((error: unknown) => {
          localMediaRequest = null;
          throw error;
        });
      }
      return localMediaRequest;
    };
    const sendPendingIceCandidates = () => {
      if (!signalingClient || mediaSession.getState().outgoingIceCandidates.length === 0) {
        return;
      }
      const candidates = mediaSession.drainOutgoingIceCandidates();
      for (const candidate of candidates) {
        if (!candidate?.candidate) continue;
        const sendResult = signalingClient.sendIceCandidate({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
        });
        if (!sendResult.ok) {
          fail(`ice candidate failed: ${sendResult.reason}`);
          return;
        }
      }
    };
    const applyCandidateOffer = (message: InboundOfferMessage) => {
      if (!shouldApplyCandidateMessage(message)) return;
      void (async () => {
        try {
          await ensureLocalMedia();
          if (closed) return;
          await mediaSession.setRemoteDescription({ type: "offer", sdp: message.sdp });
          if (closed) return;
          const answer = await mediaSession.createAnswer();
          if (closed) return;
          if (!answer.sdp) {
            throw new Error("interviewer media answer missing sdp");
          }
          const sendResult = signalingClient?.sendAnswer(answer.sdp);
          if (!sendResult) {
            throw new Error("interviewer signaling client is not available");
          }
          if (!sendResult.ok) {
            throw new Error(`answer failed: ${sendResult.reason}`);
          }
          sendPendingIceCandidates();
          setConnectionState((current) => ({
            ...current,
            status: "watching",
            candidateOnline: true,
            errorMessage: null,
          }));
        } catch (error) {
          fail(interviewerConnectionErrorMessage(error));
        }
      })();
    };
    const applyRemoteIceCandidate = (message: InboundIceCandidateMessage) => {
      if (!shouldApplyCandidateMessage(message)) return;
      void mediaSession
        .addRemoteIceCandidate({
          candidate: message.candidate,
          sdpMid: message.sdpMid ?? null,
          sdpMLineIndex: message.sdpMLineIndex ?? null,
        })
        .catch((error: unknown) => fail(interviewerConnectionErrorMessage(error)));
    };
    const updateFromMessage = (message: InboundSignalingMessage) => {
      if ("roomId" in message && message.roomId !== roomId) return;

      if (message.kind === "connected") {
        const sendResult = signalingClient?.sendJoin();
        if (sendResult && !sendResult.ok) {
          fail(`join failed: ${sendResult.reason}`);
        }
        return;
      }
      if (message.kind === "joined") {
        setConnectionState((current) => ({
          ...current,
          status: connectionStatusFromRoomStatus(message.status),
          candidateOnline: message.status === "live",
          errorMessage: null,
        }));
        return;
      }
      if (message.kind === "ended") {
        setConnectionState((current) => ({
          ...current,
          status: "ended",
          candidateOnline: false,
          errorMessage: null,
        }));
        return;
      }
      if (message.kind === "error") {
        fail(message.message);
        return;
      }
      if (message.kind === "leave" && message.role === "candidate") {
        retiredCandidateConnectionIds.add(message.connectionId);
        if (activeCandidateConnectionId !== message.connectionId) {
          return;
        }
        activeCandidateConnectionId = null;
        setConnectionState((current) => ({
          ...current,
          status: "connecting",
          candidateOnline: false,
          errorMessage: null,
        }));
        return;
      }
      if (isInboundOfferMessage(message)) {
        applyCandidateOffer(message);
        return;
      }
      if (message.kind === "ice-candidate") {
        applyRemoteIceCandidate(message);
      }
    };

    const unsubscribeIce = mediaSession.subscribe((next) => {
      if (next.outgoingIceCandidates.length > 0) {
        sendPendingIceCandidates();
      }
    });

    void roomClient.getRoom(roomId, joinCode).then((result) => {
      if (closed) return;
      if (!result.ok) {
        fail(result.error.message);
        return;
      }

      const room = result.value;
      setConnectionState({
        status: connectionStatusFromRoomStatus(room.status),
        joinCode,
        signalingUrl: room.signalingUrl,
        expiresAt: room.expiresAt,
        candidateOnline: room.candidateConnected,
        errorMessage: null,
      });
      signalingClient = createSignalingClient({
        roomId,
        role: "interviewer",
        joinCode,
        signalingUrl: room.signalingUrl,
        onMessage: updateFromMessage,
        onError: (error) => fail(error.message),
      });
    }).catch((error: unknown) => {
      fail(interviewerConnectionErrorMessage(error));
    });

    return () => {
      closed = true;
      unsubscribeIce();
      signalingClient?.close();
    };
  }, [createSignalingClient, joinCode, mediaSession, roomClient, roomId]);

  return (
    <RemoteInterviewWorkbenchView
      roomId={roomId}
      workbenchState={workbenchState}
      mediaState={mediaState}
      connectionState={connectionState}
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

function readJoinCode(search: string): string | null {
  const value = new URLSearchParams(search).get("joinCode")?.trim();
  return value && value.length > 0 ? value : null;
}

function initialRemoteConnectionState(joinCode: string | null): RemoteInterviewConnectionState {
  return {
    status: joinCode ? "connecting" : "missing-join-code",
    joinCode,
    signalingUrl: null,
    expiresAt: null,
    candidateOnline: false,
    errorMessage: joinCode ? null : "缺少 joinCode，无法加入面试房间",
  };
}

function connectionStatusFromRoomStatus(
  status: InterviewRoomStatus,
): RemoteInterviewConnectionStatus {
  switch (status) {
    case "waiting":
    case "connecting":
      return "connecting";
    case "live":
      return "watching";
    case "ended":
      return "ended";
    case "expired":
      return "failed";
  }
}

function interviewerConnectionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "interviewer signaling setup failed";
}

function isInboundOfferMessage(message: InboundSignalingMessage): message is InboundOfferMessage {
  return message.kind === "offer";
}

export function RemoteInterviewWorkbenchView({
  roomId,
  workbenchState,
  mediaState,
  connectionState = initialRemoteConnectionState(null),
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
          <SyncDetailPanel
            state={workbenchState}
            label={sync.label}
            detail={sync.detail}
            connectionState={connectionState}
          />
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
  connectionState,
}: {
  state: RemoteInterviewWorkbenchState;
  label: string;
  detail: string;
  connectionState: RemoteInterviewConnectionState;
}) {
  return (
    <section className="rounded-md border border-border bg-background p-3">
      <div className="flex items-center gap-2">
        <Activity aria-hidden size={16} className="text-primary" />
        <h2 className="text-sm font-semibold">同步状态</h2>
      </div>
      <p className="mt-3 text-sm font-medium text-foreground">{label}</p>
      <p className="mt-1 text-xs leading-5 text-muted">{detail}</p>
      <p className="mt-2 text-xs leading-5 text-muted">
        {connectionStatusText(connectionState)}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <Metric label="已应用" value={`seq ${state.lastAppliedSeq}`} />
        <Metric label="下一个" value={`seq ${state.expectedSeq}`} />
        <Metric label="房间" value={connectionLabel(connectionState)} />
        <Metric label="候选人" value={connectionState.candidateOnline ? "在线" : "离线"} />
      </dl>
    </section>
  );
}

function connectionStatusText(state: RemoteInterviewConnectionState): string {
  if (state.errorMessage) {
    return state.errorMessage;
  }
  switch (state.status) {
    case "missing-join-code":
      return "缺少 joinCode，无法加入面试房间";
    case "checking-room":
      return "正在校验面试房间";
    case "connecting":
      return "正在加入面试房间";
    case "watching":
      return "已加入面试房间";
    case "ended":
      return "面试已结束";
    case "failed":
      return "面试连接失败";
  }
}

function connectionLabel(state: RemoteInterviewConnectionState): string {
  switch (state.status) {
    case "missing-join-code":
      return "缺少 joinCode";
    case "checking-room":
      return "校验中";
    case "connecting":
      return "连接中";
    case "watching":
      return "已加入";
    case "ended":
      return "已结束";
    case "failed":
      return "失败";
  }
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
