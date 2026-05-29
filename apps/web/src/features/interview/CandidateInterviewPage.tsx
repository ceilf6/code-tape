import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import {
  CircleDot,
  ClipboardList,
  Mic,
  MicOff,
  Monitor,
  Radio,
  UserRound,
  Video,
  VideoOff,
} from "lucide-react";
import { RecorderPage } from "@/features/recorder/RecorderPage";
import { Toggle, Tooltip } from "@/shared/ui";
import {
  createInterviewMediaSession,
  type InterviewMediaSession,
  type InterviewMediaSessionState,
} from "./interviewMediaSession";
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

export type CandidateInterviewStatus =
  | "idle"
  | "creating-room"
  | "waiting-interviewer"
  | "connecting"
  | "interviewer-connected"
  | "live-recording"
  | "live-paused"
  | "ending"
  | "completed"
  | "failed";

export type CandidateInterviewRoomState = {
  status: CandidateInterviewStatus;
  joinCode: string | null;
  interviewerOnline: boolean;
  expiresAt?: string | null;
  signalingUrl?: string | null;
  errorMessage?: string | null;
};

export type CandidateInterviewViewProps = {
  roomId: string | null;
  roomState: CandidateInterviewRoomState;
  mediaState: InterviewMediaSessionState;
  recordingWorkspace: ReactNode;
};

export type CandidateInterviewPageProps = {
  deps?: {
    roomClient?: InterviewRoomClient;
    createSignalingClient?: (
      options: InterviewSignalingClientOptions,
    ) => InterviewSignalingClient;
    createMediaSession?: () => InterviewMediaSession;
  };
};

const EMPTY_CANDIDATE_MEDIA_STATE: InterviewMediaSessionState = {
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

export function CandidateInterviewPage({ deps = {} }: CandidateInterviewPageProps = {}) {
  const { roomId = null } = useParams();
  const roomClient = useMemo(
    () => deps.roomClient ?? createInterviewRoomClient(),
    [deps.roomClient],
  );
  const createSignalingClient = deps.createSignalingClient ?? createInterviewSignalingClient;
  const createMediaSession = deps.createMediaSession ?? createInterviewMediaSession;
  const session = useCandidateInterviewRoomSession({
    routeRoomId: roomId,
    roomClient,
    createSignalingClient,
    createMediaSession,
  });

  return (
    <CandidateInterviewView
      roomId={session.roomId}
      roomState={session.roomState}
      mediaState={session.mediaState}
      recordingWorkspace={<RecorderPage />}
    />
  );
}

function useCandidateInterviewRoomSession({
  routeRoomId,
  roomClient,
  createSignalingClient,
  createMediaSession,
}: {
  routeRoomId: string | null;
  roomClient: InterviewRoomClient;
  createSignalingClient: (
    options: InterviewSignalingClientOptions,
  ) => InterviewSignalingClient;
  createMediaSession: () => InterviewMediaSession;
}): {
  roomId: string | null;
  roomState: CandidateInterviewRoomState;
  mediaState: InterviewMediaSessionState;
} {
  const [session, setSession] = useState<{
    roomId: string | null;
    roomState: CandidateInterviewRoomState;
  }>(() => ({
    roomId: routeRoomId,
    roomState: initialCandidateRoomState(routeRoomId),
  }));
  const [mediaState, setMediaState] = useState<InterviewMediaSessionState>(
    EMPTY_CANDIDATE_MEDIA_STATE,
  );
  const roomCreationRef = useRef<{
    roomClient: InterviewRoomClient;
    request: ReturnType<InterviewRoomClient["createRoom"]>;
  } | null>(null);

  useEffect(() => {
    let closed = false;
    let signalingClient: InterviewSignalingClient | null = null;
    let mediaSession: InterviewMediaSession | null = null;
    let unsubscribeMediaSession: (() => void) | null = null;
    let mediaOfferStarted = false;
    let mediaSessionVersion = 0;
    let activeInterviewerConnectionId: string | null = null;
    const staleInterviewerConnectionIds = new Set<string>();

    const closeMediaSession = ({ publish }: { publish: boolean }) => {
      const current = mediaSession;
      if (!current) return;
      mediaSessionVersion += 1;
      unsubscribeMediaSession?.();
      unsubscribeMediaSession = null;
      mediaSession = null;
      mediaOfferStarted = false;
      const closedState = current.close();
      if (publish && !closed) {
        setMediaState(closedState);
      }
    };
    const isCurrentMediaSession = (
      currentMediaSession: InterviewMediaSession | null,
      currentMediaSessionVersion: number,
    ) =>
      !closed &&
      mediaSession === currentMediaSession &&
      mediaSessionVersion === currentMediaSessionVersion;

    if (routeRoomId) {
      roomCreationRef.current = null;
      setMediaState(EMPTY_CANDIDATE_MEDIA_STATE);
      setSession({
        roomId: routeRoomId,
        roomState: initialCandidateRoomState(routeRoomId),
      });
      return undefined;
    }

    setSession({
      roomId: null,
      roomState: {
        status: "creating-room",
        joinCode: null,
        interviewerOnline: false,
      },
    });
    setMediaState(EMPTY_CANDIDATE_MEDIA_STATE);

    if (!roomCreationRef.current || roomCreationRef.current.roomClient !== roomClient) {
      roomCreationRef.current = { roomClient, request: roomClient.createRoom() };
    }
    const roomRequest = roomCreationRef.current.request;

    void roomRequest.then((result) => {
      if (closed) return;

      if (!result.ok) {
        setSession({
          roomId: null,
          roomState: {
            status: "failed",
            joinCode: null,
            interviewerOnline: false,
            errorMessage: result.error.message,
          },
        });
        return;
      }

      const room = result.value;
      const failWithRoomContext = (errorMessage: string) => {
        closeMediaSession({ publish: true });
        setSession((current) => ({
          roomId: current.roomId ?? room.roomId,
          roomState: {
            ...current.roomState,
            status: "failed",
            joinCode: current.roomState.joinCode ?? room.joinCode,
            interviewerOnline: false,
            expiresAt: current.roomState.expiresAt ?? room.expiresAt,
            signalingUrl: current.roomState.signalingUrl ?? room.signalingUrl,
            errorMessage,
          },
        }));
      };
      const sendPendingIceCandidates = () => {
        if (!mediaSession || !signalingClient) return;
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
            failWithRoomContext(`ice candidate failed: ${sendResult.reason}`);
            return;
          }
        }
      };
      const openMediaSession = () => {
        if (mediaSession) return true;
        try {
          mediaSession = createMediaSession();
          mediaSessionVersion += 1;
          setMediaState(mediaSession.getState());
          unsubscribeMediaSession = mediaSession.subscribe((next) => {
            if (closed) return;
            setMediaState(next);
            if (next.outgoingIceCandidates.length > 0) {
              sendPendingIceCandidates();
            }
          });
          return true;
        } catch (error) {
          failWithRoomContext(candidateMediaErrorMessage(error));
          return false;
        }
      };
      const shouldApplyRemoteMediaMessage = (message: {
        role: "candidate" | "interviewer";
        connectionId: string;
      }) => {
        if (message.role !== "interviewer") return false;
        if (staleInterviewerConnectionIds.has(message.connectionId)) return false;
        if (
          activeInterviewerConnectionId &&
          activeInterviewerConnectionId !== message.connectionId
        ) {
          return false;
        }
        activeInterviewerConnectionId = message.connectionId;
        return true;
      };
      const startCandidateMediaOffer = () => {
        if (mediaOfferStarted) return;
        if (!openMediaSession()) return;
        const currentMediaSession = mediaSession;
        const currentMediaSessionVersion = mediaSessionVersion;
        mediaOfferStarted = true;
        void (async () => {
          try {
            if (!currentMediaSession) {
              throw new Error("candidate media session is not available");
            }
            await currentMediaSession.requestLocalMedia();
            if (!isCurrentMediaSession(currentMediaSession, currentMediaSessionVersion)) {
              return;
            }
            currentMediaSession.ensureEventsDataChannel();
            if (!isCurrentMediaSession(currentMediaSession, currentMediaSessionVersion)) {
              return;
            }
            const offer = await currentMediaSession.createOffer();
            if (!isCurrentMediaSession(currentMediaSession, currentMediaSessionVersion)) {
              return;
            }
            if (!offer.sdp) {
              throw new Error("candidate media offer missing sdp");
            }
            const sendResult = signalingClient?.sendOffer(offer.sdp);
            if (!sendResult) {
              throw new Error("candidate signaling client is not available");
            }
            if (!sendResult.ok) {
              throw new Error(`offer failed: ${sendResult.reason}`);
            }
            sendPendingIceCandidates();
          } catch (error) {
            if (isCurrentMediaSession(currentMediaSession, currentMediaSessionVersion)) {
              failWithRoomContext(candidateMediaErrorMessage(error));
            }
          }
        })();
      };
      const applyRemoteAnswer = (message: {
        role: "candidate" | "interviewer";
        connectionId: string;
        sdp: string;
      }) => {
        if (!shouldApplyRemoteMediaMessage(message)) return;
        const currentMediaSession = mediaSession;
        if (!currentMediaSession) return;
        const currentMediaSessionVersion = mediaSessionVersion;
        void (async () => {
          try {
            await currentMediaSession.setRemoteDescription({ type: "answer", sdp: message.sdp });
            if (!isCurrentMediaSession(currentMediaSession, currentMediaSessionVersion)) {
              return;
            }
          } catch (error) {
            if (isCurrentMediaSession(currentMediaSession, currentMediaSessionVersion)) {
              failWithRoomContext(candidateMediaErrorMessage(error));
            }
          }
        })();
      };
      const applyRemoteIceCandidate = (
        message: Extract<InboundSignalingMessage, { kind: "ice-candidate" }>,
      ) => {
        if (!shouldApplyRemoteMediaMessage(message)) return;
        const currentMediaSession = mediaSession;
        if (!currentMediaSession) return;
        const currentMediaSessionVersion = mediaSessionVersion;
        void (async () => {
          try {
            await currentMediaSession.addRemoteIceCandidate({
              candidate: message.candidate,
              sdpMid: message.sdpMid ?? null,
              sdpMLineIndex: message.sdpMLineIndex ?? null,
            });
            if (!isCurrentMediaSession(currentMediaSession, currentMediaSessionVersion)) {
              return;
            }
          } catch (error) {
            if (isCurrentMediaSession(currentMediaSession, currentMediaSessionVersion)) {
              failWithRoomContext(candidateMediaErrorMessage(error));
            }
          }
        })();
      };
      const updateFromMessage = (message: InboundSignalingMessage) => {
        if ("roomId" in message && message.roomId !== room.roomId) return;

        if (message.kind === "connected") {
          const sendResult = signalingClient?.sendJoin();
          if (sendResult && !sendResult.ok) {
            closeMediaSession({ publish: true });
            setSession((current) => ({
              ...current,
              roomState: {
                ...current.roomState,
                status: "failed",
                interviewerOnline: false,
                errorMessage: `join failed: ${sendResult.reason}`,
              },
            }));
          }
          return;
        }

        if (message.kind === "joined") {
          setSession({
            roomId: room.roomId,
            roomState: {
              status: candidateStatusFromRoomStatus(message.status),
              joinCode: room.joinCode,
              interviewerOnline: message.status === "live",
              expiresAt: room.expiresAt,
              signalingUrl: room.signalingUrl,
            },
          });
          if (message.role === "interviewer" && message.status === "live") {
            startCandidateMediaOffer();
          }
          return;
        }

        if (message.kind === "ended") {
          closeMediaSession({ publish: true });
          setSession((current) => ({
            ...current,
            roomState: {
              ...current.roomState,
              status: "completed",
              interviewerOnline: false,
            },
          }));
          return;
        }

        if (message.kind === "error") {
          closeMediaSession({ publish: true });
          setSession((current) => ({
            ...current,
            roomState: {
              ...current.roomState,
              status: "failed",
              interviewerOnline: false,
              errorMessage: message.message,
            },
          }));
          return;
        }

        if (message.kind === "leave" && message.role === "interviewer") {
          staleInterviewerConnectionIds.add(message.connectionId);
          if (activeInterviewerConnectionId === message.connectionId) {
            activeInterviewerConnectionId = null;
          }
          closeMediaSession({ publish: true });
          setSession((current) => ({
            ...current,
            roomState: {
              ...current.roomState,
              status: "waiting-interviewer",
              interviewerOnline: false,
            },
          }));
          return;
        }

        if (message.kind === "answer") {
          applyRemoteAnswer(message);
          return;
        }

        if (message.kind === "ice-candidate") {
          applyRemoteIceCandidate(message);
        }
      };

      if (!openMediaSession()) return;

      setSession({
        roomId: room.roomId,
        roomState: {
          status: candidateStatusFromRoomStatus(room.status),
          joinCode: room.joinCode,
          interviewerOnline: room.status === "live",
          expiresAt: room.expiresAt,
          signalingUrl: room.signalingUrl,
        },
      });

      signalingClient = createSignalingClient({
        roomId: room.roomId,
        role: "candidate",
        joinCode: room.joinCode,
        signalingUrl: room.signalingUrl,
        onMessage: updateFromMessage,
        onError: (error) => {
          if (closed) return;
          closeMediaSession({ publish: true });
          setSession((current) => ({
            ...current,
            roomState: {
              ...current.roomState,
              status: "failed",
              interviewerOnline: false,
              errorMessage: error.message,
            },
          }));
        },
      });
    }).catch((error: unknown) => {
      if (closed) return;
      setSession({
        roomId: null,
        roomState: {
          status: "failed",
          joinCode: null,
          interviewerOnline: false,
          errorMessage: candidateRoomCreationErrorMessage(error),
        },
      });
    }).finally(() => {
      if (roomCreationRef.current?.request === roomRequest) {
        roomCreationRef.current = null;
      }
    });

    return () => {
      closed = true;
      closeMediaSession({ publish: false });
      signalingClient?.close();
    };
  }, [createMediaSession, createSignalingClient, roomClient, routeRoomId]);

  return { ...session, mediaState };
}

function initialCandidateRoomState(routeRoomId: string | null): CandidateInterviewRoomState {
  return routeRoomId
    ? {
        status: "waiting-interviewer",
        joinCode: null,
        interviewerOnline: false,
        errorMessage: "缺少 joinCode，当前仅展示候选人录制工作区",
      }
    : {
        status: "idle",
        joinCode: null,
        interviewerOnline: false,
      };
}

function candidateRoomCreationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "interview room request failed";
}

function candidateMediaErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "candidate media setup failed";
}

function candidateStatusFromRoomStatus(status: InterviewRoomStatus): CandidateInterviewStatus {
  switch (status) {
    case "waiting":
      return "waiting-interviewer";
    case "connecting":
      return "connecting";
    case "live":
      return "interviewer-connected";
    case "ended":
      return "completed";
    case "expired":
      return "failed";
  }
}

export function CandidateInterviewView({
  roomId,
  roomState,
  mediaState,
  recordingWorkspace,
}: CandidateInterviewViewProps) {
  const status = candidateStatusView(roomState);
  const micLabel = mediaState.microphoneEnabled ? "麦克风已开启" : "麦克风已关闭";
  const cameraLabel = mediaState.cameraEnabled ? "摄像头已开启" : "摄像头已关闭";

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex min-h-16 flex-wrap items-center gap-3 border-b border-border bg-surface/80 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <ClipboardList aria-hidden size={18} className="text-primary" />
            <h1 className="font-display text-base font-semibold">候选人面试</h1>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span>房间</span>
            <span className="max-w-[18rem] truncate font-mono text-foreground">
              {roomId ?? "等待创建"}
            </span>
            <span>joinCode</span>
            <span className="font-mono text-foreground">{roomState.joinCode ?? "等待创建"}</span>
          </div>
        </div>
        <div
          role="status"
          aria-live="polite"
          className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${status.toneClass}`}
        >
          <CircleDot aria-hidden size={16} />
          <span className="font-medium">{status.label}</span>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-label="候选人录制工作区" className="min-h-0 overflow-auto">
          {recordingWorkspace}
        </section>

        <aside
          aria-label="实时面试侧栏"
          className="flex min-h-0 flex-col gap-4 overflow-auto border-l border-border bg-surface px-4 py-4"
        >
          <section className="rounded-md border border-border bg-background p-3">
            <div className="flex items-center gap-2">
              <Radio aria-hidden size={16} className="text-primary" />
              <h2 className="text-sm font-semibold">房间状态</h2>
            </div>
            <p className="mt-3 text-sm font-medium text-foreground">{status.label}</p>
            <p className="mt-1 text-xs leading-5 text-muted">{status.detail}</p>
            <dl className="mt-3 grid gap-2 text-xs">
              <Metric label="面试官" value={roomState.interviewerOnline ? "在线" : "离线"} />
              {roomState.expiresAt ? <Metric label="有效期" value={roomState.expiresAt} /> : null}
              {roomState.signalingUrl ? (
                <Metric label="信令" value={roomState.signalingUrl} />
              ) : null}
              <Metric label="WebRTC" value={mediaState.connectionState} />
              <Metric label="ICE" value={mediaState.iceConnectionState} />
            </dl>
          </section>

          <section className="rounded-md border border-border bg-background p-3">
            <div className="flex items-center gap-2">
              <Monitor aria-hidden size={16} className="text-primary" />
              <h2 className="text-sm font-semibold">音视频</h2>
            </div>
            <div className="mt-3 grid gap-3">
              <MediaStreamTile
                title="面试官视频"
                stream={mediaState.remoteStream}
                muted={false}
                placeholder={<UserRound aria-hidden size={28} />}
              />
              <MediaStreamTile
                title="本地预览"
                stream={mediaState.localStream}
                muted
                placeholder={<Monitor aria-hidden size={28} />}
              />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <Tooltip content={micLabel}>
                <Toggle
                  pressed={mediaState.microphoneEnabled}
                  onPressedChange={() => {}}
                  disabled
                  label={micLabel}
                  icon={<MicOff size={17} />}
                  iconPressed={<Mic size={17} />}
                />
              </Tooltip>
              <Tooltip content={cameraLabel}>
                <Toggle
                  pressed={mediaState.cameraEnabled}
                  onPressedChange={() => {}}
                  disabled
                  label={cameraLabel}
                  icon={<VideoOff size={17} />}
                  iconPressed={<Video size={17} />}
                />
              </Tooltip>
              <span className="ml-auto text-xs text-muted">{mediaState.signalingState}</span>
            </div>
          </section>
        </aside>
      </div>
    </div>
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

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-surface px-2 py-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate font-mono text-foreground">
        {label === "面试官" ? `面试官${value}` : value}
      </dd>
    </div>
  );
}

function candidateStatusView(state: CandidateInterviewRoomState): {
  label: string;
  detail: string;
  toneClass: string;
} {
  switch (state.status) {
    case "idle":
      return {
        label: "准备创建房间",
        detail: "创建房间后可分享 joinCode，并继续使用现有录制工作区",
        toneClass: "border-border bg-surface text-muted",
      };
    case "creating-room":
      return {
        label: "正在创建房间",
        detail: "正在请求面试房间和短期 joinCode",
        toneClass: "border-warning/40 bg-warning/10 text-warning",
      };
    case "waiting-interviewer":
      return {
        label: "等待面试官",
        detail: state.errorMessage ?? "面试官加入前可以先确认设备和录制环境",
        toneClass: "border-warning/40 bg-warning/10 text-warning",
      };
    case "connecting":
      return {
        label: "连接中",
        detail: "正在建立信令和媒体连接",
        toneClass: "border-warning/40 bg-warning/10 text-warning",
      };
    case "interviewer-connected":
      return {
        label: "面试官已加入",
        detail: "信令已连接，等待后续媒体和事件同步接线",
        toneClass: "border-success/40 bg-success/10 text-success",
      };
    case "live-recording":
      return {
        label: "面试录制中",
        detail: "候选人事件流将用于实时同步和最终回放",
        toneClass: "border-success/40 bg-success/10 text-success",
      };
    case "live-paused":
      return {
        label: "面试已暂停",
        detail: "已保留当前房间和录制状态",
        toneClass: "border-warning/40 bg-warning/10 text-warning",
      };
    case "ending":
      return {
        label: "正在结束",
        detail: "正在收口房间并准备保存回放",
        toneClass: "border-warning/40 bg-warning/10 text-warning",
      };
    case "completed":
      return {
        label: "面试已完成",
        detail: "可以继续按现有保存流程生成回放",
        toneClass: "border-success/40 bg-success/10 text-success",
      };
    case "failed":
      return {
        label: "连接失败",
        detail: state.errorMessage ?? "保留录制工作区，稍后可重新连接",
        toneClass: "border-danger/40 bg-danger/10 text-danger",
      };
  }
}
