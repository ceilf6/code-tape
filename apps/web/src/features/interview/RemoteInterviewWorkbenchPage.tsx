import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  Activity,
  CircleDot,
  Mic,
  MicOff,
  Monitor,
  Radio,
  SignalHigh,
  TriangleAlert,
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
  | "validating-room"
  | "connecting"
  | "joined"
  | "failed";

export type RemoteInterviewConnectionState = {
  status: RemoteInterviewConnectionStatus;
  errorMessage: string | null;
};

export type RemoteInterviewWorkbenchViewProps = {
  roomId: string;
  workbenchState: RemoteInterviewWorkbenchState;
  mediaState: InterviewMediaSessionState;
  connectionState: RemoteInterviewConnectionState;
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
  joinCodeInvalid: boolean;
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
  const [searchParams] = useSearchParams();
  const joinCodeResult = parseJoinCode(searchParams.get("joinCode"));
  const joinCode = joinCodeResult.status === "valid" ? joinCodeResult.joinCode : null;

  return (
    <RemoteInterviewWorkbenchRoom
      key={`${roomId}::${joinCodeResult.key}`}
      roomId={roomId}
      joinCode={joinCode}
      joinCodeInvalid={joinCodeResult.status === "invalid"}
      deps={deps}
    />
  );
}

function RemoteInterviewWorkbenchRoom({
  roomId,
  joinCode,
  joinCodeInvalid,
  deps,
}: RemoteInterviewWorkbenchRoomProps) {
  const createMediaSession = deps.createMediaSession ?? createInterviewMediaSession;
  const roomClient = useMemo(
    () => deps.roomClient ?? createInterviewRoomClient(),
    [deps.roomClient],
  );
  const createSignalingClient = deps.createSignalingClient ?? createInterviewSignalingClient;
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
    initialConnectionState(joinCode, joinCodeInvalid),
  );
  const [sessionEpoch, setSessionEpoch] = useState(0);

  useEffect(() => workbench.subscribe(setWorkbenchState), [workbench]);
  useEffect(() => {
    const nextMediaSession = safeCreateMediaSession(createMediaSession);
    setMediaSession(nextMediaSession);
    setMediaState(nextMediaSession?.getState() ?? emptyInterviewMediaSessionState());
    if (!nextMediaSession && joinCode) {
      setConnectionState({
        status: "failed",
        errorMessage: "当前环境不支持 WebRTC，无法建立面试音视频连接",
      });
    }

    return () => {
      nextMediaSession?.close();
    };
  }, [createMediaSession, joinCode, sessionEpoch]);
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
    if (!mediaSession) {
      return undefined;
    }
    if (joinCodeInvalid) {
      setConnectionState({
        status: "missing-join-code",
        errorMessage: "joinCode 格式非法，无法加入面试房间",
      });
      return undefined;
    }
    return connectInterviewerSignaling({
      roomId,
      joinCode,
      roomClient,
      createSignalingClient,
      mediaSession,
      onConnectionState: setConnectionState,
      onCandidateLeft: () => setSessionEpoch((epoch) => epoch + 1),
    });
  }, [createSignalingClient, joinCode, joinCodeInvalid, mediaSession, roomClient, roomId]);

  return (
    <RemoteInterviewWorkbenchView
      roomId={roomId}
      workbenchState={workbenchState}
      mediaState={mediaState}
      connectionState={connectionState}
    />
  );
}

function connectInterviewerSignaling({
  roomId,
  joinCode,
  roomClient,
  createSignalingClient,
  mediaSession,
  onConnectionState,
  onCandidateLeft,
}: {
  roomId: string;
  joinCode: string | null;
  roomClient: InterviewRoomClient;
  createSignalingClient: (
    options: InterviewSignalingClientOptions,
  ) => InterviewSignalingClient;
  mediaSession: InterviewMediaSession;
  onConnectionState: (state: RemoteInterviewConnectionState) => void;
  onCandidateLeft: () => void;
}): () => void {
  if (!joinCode) {
    onConnectionState({
      status: "missing-join-code",
      errorMessage: "缺少 joinCode，无法加入面试房间",
    });
    return () => {};
  }

  let closed = false;
  let signalingClient: InterviewSignalingClient | null = null;
  let unsubscribeMediaSession: (() => void) | null = null;
  let answerStarted = false;
  let remoteDescriptionSet = false;
  let activeCandidateConnectionId: string | null = null;
  let pendingRemoteIceCandidates: Array<{
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  }> = [];

  const fail = (errorMessage: string) => {
    if (closed) return;
    onConnectionState({ status: "failed", errorMessage });
  };
  const failAndStopMedia = (errorMessage: string) => {
    if (closed) return;
    mediaSession.close();
    signalingClient?.close();
    signalingClient = null;
    onConnectionState({ status: "failed", errorMessage });
  };
  const resetCandidateSession = () => {
    answerStarted = false;
    remoteDescriptionSet = false;
    activeCandidateConnectionId = null;
    pendingRemoteIceCandidates = [];
  };
  const sendPendingIceCandidates = () => {
    if (closed || !signalingClient) return;
    if (mediaSession.getState().outgoingIceCandidates.length === 0) return;
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
  const addRemoteIceCandidate = (candidate: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
  }) => {
    void (async () => {
      try {
        await mediaSession.addRemoteIceCandidate({
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
        });
      } catch (error) {
        fail(interviewerMediaErrorMessage(error));
      }
    })();
  };
  const flushPendingRemoteIceCandidates = () => {
    const pending = pendingRemoteIceCandidates;
    pendingRemoteIceCandidates = [];
    for (const candidate of pending) {
      addRemoteIceCandidate(candidate);
    }
  };
  const shouldApplyCandidateMessage = (message: {
    role: "candidate" | "interviewer";
    connectionId: string;
  }) => {
    if (message.role !== "candidate") return false;
    if (
      activeCandidateConnectionId &&
      activeCandidateConnectionId !== message.connectionId
    ) {
      return false;
    }
    activeCandidateConnectionId = message.connectionId;
    return true;
  };
  const answerCandidateOffer = (sdp: string) => {
    if (closed || answerStarted) return;
    answerStarted = true;
    onConnectionState({ status: "connecting", errorMessage: null });
    void (async () => {
      try {
        await mediaSession.requestLocalMedia();
        if (closed) return;
        await mediaSession.setRemoteDescription({ type: "offer", sdp });
        if (closed) return;
        remoteDescriptionSet = true;
        flushPendingRemoteIceCandidates();
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
        if (closed) return;
        onConnectionState({ status: "joined", errorMessage: null });
        sendPendingIceCandidates();
      } catch (error) {
        if (!closed) {
          answerStarted = false;
          fail(interviewerMediaErrorMessage(error));
        }
      }
    })();
  };
  const applyRemoteIceCandidate = (
    message: Extract<InboundSignalingMessage, { kind: "ice-candidate" }>,
  ) => {
    if (closed) return;
    if (!shouldApplyCandidateMessage(message)) return;
    const candidate = {
      candidate: message.candidate,
      sdpMid: message.sdpMid ?? null,
      sdpMLineIndex: message.sdpMLineIndex ?? null,
    };
    if (!remoteDescriptionSet) {
      pendingRemoteIceCandidates = [...pendingRemoteIceCandidates, candidate];
      return;
    }
    addRemoteIceCandidate(candidate);
  };
  const handleMessage = (message: InboundSignalingMessage) => {
    if (closed) return;
    if ("roomId" in message && message.roomId !== roomId) return;

    if (message.kind === "connected") {
      const sendResult = signalingClient?.sendJoin();
      if (sendResult && !sendResult.ok) {
        fail(`join failed: ${sendResult.reason}`);
      }
      return;
    }
    if (message.kind === "ended") {
      mediaSession.close();
      signalingClient?.close();
      signalingClient = null;
      onConnectionState({ status: "failed", errorMessage: "面试房间已结束" });
      return;
    }
    if (message.kind === "error") {
      fail(message.message);
      return;
    }
    if (message.kind === "leave" && message.role === "candidate") {
      if (
        activeCandidateConnectionId &&
        activeCandidateConnectionId === message.connectionId
      ) {
        resetCandidateSession();
        onConnectionState({ status: "connecting", errorMessage: null });
        onCandidateLeft();
      }
      return;
    }
    if (message.kind === "offer") {
      if (!shouldApplyCandidateMessage(message)) return;
      answerCandidateOffer(message.sdp);
      return;
    }
    if (message.kind === "ice-candidate") {
      applyRemoteIceCandidate(message);
    }
  };

  onConnectionState({ status: "validating-room", errorMessage: null });
  void roomClient
    .getRoom(roomId, joinCode)
    .then((result) => {
      if (closed) return;
      if (!result.ok) {
        fail(result.error.message);
        return;
      }
      onConnectionState({ status: "connecting", errorMessage: null });
      unsubscribeMediaSession = mediaSession.subscribe((next) => {
        if (closed) return;
        if (next.outgoingIceCandidates.length > 0) {
          sendPendingIceCandidates();
        }
      });
      signalingClient = createSignalingClient({
        roomId,
        role: "interviewer",
        joinCode,
        signalingUrl: result.value.signalingUrl,
        onMessage: handleMessage,
        onError: (error) => failAndStopMedia(error.message),
      });
    })
    .catch((error: unknown) => {
      fail(interviewerRoomErrorMessage(error));
    });

  return () => {
    closed = true;
    unsubscribeMediaSession?.();
    signalingClient?.close();
  };
}

type ParsedJoinCode =
  | { status: "missing"; key: ""; joinCode: null }
  | { status: "invalid"; key: string; joinCode: null }
  | { status: "valid"; key: string; joinCode: string };

const JOIN_CODE_PATTERN = /^[0-9A-Za-z]{8}$/u;

function parseJoinCode(value: string | null): ParsedJoinCode {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { status: "missing", key: "", joinCode: null };
  }
  if (!JOIN_CODE_PATTERN.test(trimmed)) {
    return { status: "invalid", key: `invalid:${trimmed}`, joinCode: null };
  }
  return { status: "valid", key: trimmed, joinCode: trimmed };
}

function initialConnectionState(
  joinCode: string | null,
  joinCodeInvalid: boolean,
): RemoteInterviewConnectionState {
  if (joinCode) {
    return { status: "validating-room", errorMessage: null };
  }
  return {
    status: "missing-join-code",
    errorMessage: joinCodeInvalid
      ? "joinCode 格式非法，无法加入面试房间"
      : "缺少 joinCode，无法加入面试房间",
  };
}

function interviewerMediaErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "interviewer media setup failed";
}

function interviewerRoomErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "interview room request failed";
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
  connectionState,
}: RemoteInterviewWorkbenchViewProps) {
  const editor = workbenchState.stableState.editor;
  const sync = syncStatusView(workbenchState);
  const connection = connectionStatusView(connectionState);

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
          <ConnectionStatusPanel state={connectionState} view={connection} />
          <SyncDetailPanel state={workbenchState} label={sync.label} detail={sync.detail} />
          <InterviewMediaPanel state={mediaState} />
        </aside>
      </div>
    </div>
  );
}

function ConnectionStatusPanel({
  state,
  view,
}: {
  state: RemoteInterviewConnectionState;
  view: { label: string; detail: string; toneClass: string };
}) {
  return (
    <section
      role="status"
      aria-live="polite"
      className={`rounded-md border p-3 ${view.toneClass}`}
    >
      <div className="flex items-center gap-2">
        <TriangleAlert aria-hidden size={16} />
        <h2 className="text-sm font-semibold">房间连接</h2>
      </div>
      <p className="mt-3 text-sm font-medium">{view.label}</p>
      <p className="mt-1 text-xs leading-5">{state.errorMessage ?? view.detail}</p>
    </section>
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

function connectionStatusView(state: RemoteInterviewConnectionState): {
  label: string;
  detail: string;
  toneClass: string;
} {
  switch (state.status) {
    case "missing-join-code":
      return {
        label: "缺少 joinCode",
        detail: "缺少 joinCode，无法加入面试房间",
        toneClass: "border-danger/40 bg-danger/10 text-danger",
      };
    case "validating-room":
      return {
        label: "校验房间中",
        detail: "正在校验房间和 joinCode",
        toneClass: "border-warning/40 bg-warning/10 text-warning",
      };
    case "connecting":
      return {
        label: "连接中",
        detail: "正在建立信令并等待候选人发起媒体协商",
        toneClass: "border-warning/40 bg-warning/10 text-warning",
      };
    case "joined":
      return {
        label: "已加入房间",
        detail: "已应答候选人媒体协商，正在接收实时编辑事件",
        toneClass: "border-success/40 bg-success/10 text-success",
      };
    case "failed":
      return {
        label: "连接失败",
        detail: "保留最后稳定代码，可稍后重新加入",
        toneClass: "border-danger/40 bg-danger/10 text-danger",
      };
  }
}
