import { act, render, screen } from "@testing-library/react";
import { StrictMode, type ComponentProps } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { appRoutes } from "@/app/routes";
import { ThemeProvider } from "@/shared/ui/themeProvider";
import { TooltipProvider } from "@/shared/ui/Tooltip";
import type { InterviewMediaSessionState } from "../interviewMediaSession";
import type { InterviewRoomClient } from "../interviewRoomClient";
import type {
  InboundSignalingMessage,
  InterviewSignalingClient,
  InterviewSignalingClientOptions,
} from "../interviewSignalingClient";
import { CandidateInterviewPage, CandidateInterviewView } from "../CandidateInterviewPage";

vi.mock("@/features/recorder/RecorderPage", () => ({
  RecorderPage() {
    return <div data-testid="recorder-workspace">Recorder workspace</div>;
  },
}));

describe("CandidateInterviewPage", () => {
  it("creates a room and connects candidate signaling from the candidate entry route", async () => {
    const roomClient = makeRoomClient({
      createRoom: vi.fn().mockResolvedValue({
        ok: true,
        value: {
          roomId: "room-created",
          joinCode: "JOIN1234",
          status: "waiting",
          expiresAt: "2026-05-29T17:00:00.000Z",
          signalingUrl: "/api/interviews/rooms/room-created/signaling",
        },
      }),
    });
    const signaling = makeSignalingFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
    });

    expect(await screen.findByText("room-created")).toBeInTheDocument();
    expect(screen.getByText("JOIN1234")).toBeInTheDocument();
    expect(screen.getByText("2026-05-29T17:00:00.000Z")).toBeInTheDocument();
    expect(screen.getByText("/api/interviews/rooms/room-created/signaling")).toBeInTheDocument();
    expect(signaling.create).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "room-created",
        role: "candidate",
        joinCode: "JOIN1234",
        signalingUrl: "/api/interviews/rooms/room-created/signaling",
      }),
    );

    act(() => {
      signaling.emit({
        kind: "connected",
        roomId: "room-created",
        connectionId: "candidate-connection-1",
      });
    });

    expect(signaling.client.sendJoin).toHaveBeenCalledTimes(1);

    act(() => {
      signaling.emit({
        kind: "joined",
        roomId: "room-created",
        role: "candidate",
        status: "live",
      });
    });

    expect(screen.getAllByText("面试官已加入")).toHaveLength(2);
    expect(screen.getByText("面试官在线")).toBeInTheDocument();
  });

  it("reuses in-flight room creation during StrictMode effect replay", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
      strict: true,
    });

    expect(await screen.findByText("room-created")).toBeInTheDocument();
    expect(roomClient.createRoom).toHaveBeenCalledTimes(1);
    expect(signaling.create).toHaveBeenCalledTimes(1);
  });

  it("keeps the recorder workspace visible when room creation fails", async () => {
    const roomClient = makeRoomClient({
      createRoom: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "network-error", message: "offline" },
      }),
    });
    const signaling = makeSignalingFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
    });

    expect(await screen.findAllByText("连接失败")).toHaveLength(2);
    expect(screen.getByText("offline")).toBeInTheDocument();
    expect(screen.getByTestId("recorder-workspace")).toBeInTheDocument();
    expect(signaling.create).not.toHaveBeenCalled();
  });

  it("keeps the recorder workspace visible when room creation rejects", async () => {
    const roomClient = makeRoomClient({
      createRoom: vi.fn().mockRejectedValue(new Error("fetch failed")),
    });
    const signaling = makeSignalingFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
    });

    expect(await screen.findAllByText("连接失败")).toHaveLength(2);
    expect(screen.getByText("fetch failed")).toBeInTheDocument();
    expect(screen.getByTestId("recorder-workspace")).toBeInTheDocument();
    expect(signaling.create).not.toHaveBeenCalled();
  });

  it("maps candidate signaling ended and error messages to visible room state", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
    });
    await screen.findByText("room-created");

    act(() => {
      signaling.emit({ kind: "ended", roomId: "room-created" });
    });
    expect(screen.getAllByText("面试已完成")).toHaveLength(2);

    act(() => {
      signaling.emit({
        kind: "error",
        code: "join-rejected",
        message: "room already has a candidate",
      });
    });
    expect(screen.getAllByText("连接失败")).toHaveLength(2);
    expect(screen.getByText("room already has a candidate")).toBeInTheDocument();
  });

  it("keeps interviewer offline for a candidate-only join until the interviewer joins", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
    });
    await screen.findByText("room-created");

    act(() => {
      signaling.emit({
        kind: "joined",
        roomId: "room-created",
        role: "candidate",
        status: "connecting",
      });
    });
    expect(screen.getByText("面试官离线")).toBeInTheDocument();
    expect(screen.queryByText("面试官在线")).not.toBeInTheDocument();

    act(() => {
      signaling.emit({
        kind: "joined",
        roomId: "room-created",
        role: "interviewer",
        status: "live",
      });
    });
    expect(screen.getByText("面试官在线")).toBeInTheDocument();
  });

  it("clears interviewer presence when signaling fails after a live join", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
    });
    await screen.findByText("room-created");

    act(() => {
      signaling.emit({
        kind: "joined",
        roomId: "room-created",
        role: "interviewer",
        status: "live",
      });
    });
    expect(screen.getByText("面试官在线")).toBeInTheDocument();

    act(() => {
      signaling.emit({
        kind: "error",
        code: "join-rejected",
        message: "room already has a candidate",
      });
    });
    expect(screen.getAllByText("连接失败")).toHaveLength(2);
    expect(screen.getByText("面试官离线")).toBeInTheDocument();
  });

  it("clears interviewer presence when the signaling socket errors after a live join", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
    });
    await screen.findByText("room-created");

    act(() => {
      signaling.emit({
        kind: "joined",
        roomId: "room-created",
        role: "interviewer",
        status: "live",
      });
    });
    expect(screen.getByText("面试官在线")).toBeInTheDocument();

    act(() => {
      signaling.emitError({
        code: "socket-error",
        message: "interview signaling socket error",
      });
    });
    expect(screen.getAllByText("连接失败")).toHaveLength(2);
    expect(screen.getByText("面试官离线")).toBeInTheDocument();
  });

  it("marks the interviewer offline when an interviewer leave message arrives", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
    });
    await screen.findByText("room-created");

    act(() => {
      signaling.emit({
        kind: "joined",
        roomId: "room-created",
        role: "interviewer",
        status: "live",
      });
    });
    expect(screen.getByText("面试官在线")).toBeInTheDocument();

    act(() => {
      signaling.emit({
        kind: "leave",
        roomId: "room-created",
        role: "interviewer",
        connectionId: "interviewer-connection-1",
        messageId: "leave-1",
        sentAt: 1_780_000_000_000,
      });
    });
    expect(screen.getAllByText("等待面试官")).toHaveLength(2);
    expect(screen.getByText("面试官离线")).toBeInTheDocument();
  });

  it("maps malformed signaling client errors to visible failed room state", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
    });
    await screen.findByText("room-created");

    act(() => {
      signaling.emitError({
        code: "bad-message",
        message: "signaling message is missing kind",
      });
    });

    expect(screen.getAllByText("连接失败")).toHaveLength(2);
    expect(screen.getByText("signaling message is missing kind")).toBeInTheDocument();
    expect(screen.getByTestId("recorder-workspace")).toBeInTheDocument();
  });

  it("closes the signaling client when the candidate page unmounts", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();

    const view = renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
    });
    await screen.findByText("room-created");

    view.unmount();

    expect(signaling.client.close).toHaveBeenCalledTimes(1);
  });

  it("keeps routed candidate rooms in read-only recording mode without a join code", () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate/room-route",
      roomClient,
      createSignalingClient: signaling.create,
    });

    expect(screen.getByText("room-route")).toBeInTheDocument();
    expect(screen.getByText("缺少 joinCode，当前仅展示候选人录制工作区")).toBeInTheDocument();
    expect(screen.getByTestId("recorder-workspace")).toBeInTheDocument();
    expect(roomClient.createRoom).not.toHaveBeenCalled();
    expect(signaling.create).not.toHaveBeenCalled();
  });

  it("renders the candidate room status and recording workspace", () => {
    renderCandidateView({
      roomId: "room-42",
      roomState: {
        status: "waiting-interviewer",
        joinCode: "JOIN1234",
        interviewerOnline: false,
      },
      mediaState: makeMediaState(),
      recordingWorkspace: <div data-testid="custom-recorder">Recording area</div>,
    });

    expect(screen.getByRole("heading", { name: "候选人面试" })).toBeInTheDocument();
    expect(screen.getByText("room-42")).toBeInTheDocument();
    expect(screen.getByText("JOIN1234")).toBeInTheDocument();
    expect(screen.getAllByText("等待面试官")).toHaveLength(2);
    expect(screen.getByTestId("custom-recorder")).toHaveTextContent("Recording area");
  });

  it("shows room creation and media placeholders before real signaling is wired", () => {
    renderCandidateView({
      roomId: null,
      roomState: {
        status: "idle",
        joinCode: null,
        interviewerOnline: false,
      },
      mediaState: makeMediaState({
        microphoneEnabled: false,
        cameraEnabled: false,
        connectionState: "new",
      }),
      recordingWorkspace: <div>Recording area</div>,
    });

    expect(screen.getAllByText("准备创建房间")).toHaveLength(2);
    expect(screen.getAllByText("等待创建")).toHaveLength(2);
    expect(screen.getByText("面试官离线")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "面试官视频占位" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "本地预览占位" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "麦克风已关闭" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "摄像头已关闭" })).toBeDisabled();
  });

  it("registers the candidate interview route without replacing the recorder route", () => {
    const router = createMemoryRouter(appRoutes, {
      initialEntries: ["/interview/candidate/room-route"],
    });

    render(
      <ThemeProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </ThemeProvider>,
    );

    expect(screen.getByRole("heading", { name: "候选人面试" })).toBeInTheDocument();
    expect(screen.getByText("room-route")).toBeInTheDocument();
    expect(screen.getByTestId("recorder-workspace")).toBeInTheDocument();
  });

  it("keeps the existing recorder route pointed at the recorder workspace", () => {
    const router = createMemoryRouter(appRoutes, {
      initialEntries: ["/record"],
    });

    render(
      <ThemeProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </ThemeProvider>,
    );

    expect(screen.getByTestId("recorder-workspace")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "候选人面试" })).not.toBeInTheDocument();
  });
});

function renderCandidatePage({
  initialEntry,
  roomClient,
  createSignalingClient,
  strict = false,
}: {
  initialEntry: string;
  roomClient: InterviewRoomClient;
  createSignalingClient: (options: InterviewSignalingClientOptions) => InterviewSignalingClient;
  strict?: boolean;
}) {
  const router = createMemoryRouter(
    [
      {
        path: "/interview/candidate/:roomId?",
        element: (
          <CandidateInterviewPage
            deps={{
              roomClient,
              createSignalingClient,
            }}
          />
        ),
      },
    ],
    { initialEntries: [initialEntry] },
  );

  const tree = (
    <ThemeProvider>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </ThemeProvider>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

function renderCandidateView(props: ComponentProps<typeof CandidateInterviewView>) {
  return render(
    <TooltipProvider>
      <CandidateInterviewView {...props} />
    </TooltipProvider>,
  );
}

function makeMediaState(
  patch: Partial<InterviewMediaSessionState> = {},
): InterviewMediaSessionState {
  return {
    localStream: null,
    remoteStream: null,
    microphoneEnabled: false,
    cameraEnabled: false,
    connectionState: "new",
    iceConnectionState: "new",
    signalingState: "stable",
    outgoingIceCandidates: [],
    ...patch,
  };
}

function makeRoomClient(patch: Partial<InterviewRoomClient> = {}): InterviewRoomClient {
  return {
    createRoom: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        roomId: "room-created",
        joinCode: "JOIN1234",
        status: "waiting",
        expiresAt: "2026-05-29T17:00:00.000Z",
        signalingUrl: "/api/interviews/rooms/room-created/signaling",
      },
    }),
    getRoom: vi.fn(),
    endRoom: vi.fn(),
    ...patch,
  };
}

function makeSignalingFactory() {
  let onMessage: ((message: InboundSignalingMessage) => void) | undefined;
  let onError: InterviewSignalingClientOptions["onError"] | undefined;
  const client: InterviewSignalingClient = {
    socket: {} as InterviewSignalingClient["socket"],
    getConnectionId: vi.fn(() => "candidate-connection-1"),
    sendJoin: vi.fn(() => ({ ok: true as const, message: {} as never })),
    sendOffer: vi.fn(),
    sendAnswer: vi.fn(),
    sendIceCandidate: vi.fn(),
    sendHeartbeat: vi.fn(),
    sendLeave: vi.fn(),
    close: vi.fn(),
  };

  return {
    client,
    create: vi.fn((options: InterviewSignalingClientOptions) => {
      onMessage = options.onMessage;
      onError = options.onError;
      return client;
    }),
    emit(message: InboundSignalingMessage) {
      if (!onMessage) {
        throw new Error("signaling client was not created");
      }
      onMessage(message);
    },
    emitError(error: Parameters<NonNullable<InterviewSignalingClientOptions["onError"]>>[0]) {
      if (!onError) {
        throw new Error("signaling client was not created");
      }
      onError(error);
    },
  };
}
