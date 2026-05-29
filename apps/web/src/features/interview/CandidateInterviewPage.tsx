import { useEffect, useMemo, useRef, type ReactNode } from "react";
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
import type { InterviewMediaSessionState } from "./interviewMediaSession";

export type CandidateInterviewStatus =
  | "idle"
  | "waiting-interviewer"
  | "connecting"
  | "live-recording"
  | "live-paused"
  | "ending"
  | "completed"
  | "failed";

export type CandidateInterviewRoomState = {
  status: CandidateInterviewStatus;
  joinCode: string | null;
  interviewerOnline: boolean;
};

export type CandidateInterviewViewProps = {
  roomId: string | null;
  roomState: CandidateInterviewRoomState;
  mediaState: InterviewMediaSessionState;
  recordingWorkspace: ReactNode;
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
};

export function CandidateInterviewPage() {
  const { roomId = null } = useParams();
  const roomState = useMemo<CandidateInterviewRoomState>(
    () =>
      roomId
        ? {
            status: "waiting-interviewer",
            joinCode: null,
            interviewerOnline: false,
          }
        : {
            status: "idle",
            joinCode: null,
            interviewerOnline: false,
          },
    [roomId],
  );

  return (
    <CandidateInterviewView
      roomId={roomId}
      roomState={roomState}
      mediaState={EMPTY_CANDIDATE_MEDIA_STATE}
      recordingWorkspace={<RecorderPage />}
    />
  );
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
    case "waiting-interviewer":
      return {
        label: "等待面试官",
        detail: "面试官加入前可以先确认设备和录制环境",
        toneClass: "border-warning/40 bg-warning/10 text-warning",
      };
    case "connecting":
      return {
        label: "连接中",
        detail: "正在建立信令和媒体连接",
        toneClass: "border-warning/40 bg-warning/10 text-warning",
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
        detail: "保留录制工作区，稍后可重新连接",
        toneClass: "border-danger/40 bg-danger/10 text-danger",
      };
  }
}
