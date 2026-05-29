import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, type ComponentProps } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { appRoutes } from "@/app/routes";
import { ThemeProvider } from "@/shared/ui/themeProvider";
import { TooltipProvider } from "@/shared/ui/Tooltip";
import type {
  InterviewEventsDataChannel,
  InterviewMediaSession,
  InterviewMediaSessionState,
} from "../interviewMediaSession";
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

  it("starts the candidate media offer after the interviewer joins", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeMediaSessionFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });
    await screen.findByText("room-created");

    act(() => {
      signaling.emit({
        kind: "connected",
        roomId: "room-created",
        connectionId: "candidate-connection-1",
      });
      signaling.emit({
        kind: "joined",
        roomId: "room-created",
        role: "interviewer",
        status: "live",
      });
    });

    await waitFor(() => {
      expect(media.session.requestLocalMedia).toHaveBeenCalledTimes(1);
      expect(media.session.ensureEventsDataChannel).toHaveBeenCalledTimes(1);
      expect(media.session.createOffer).toHaveBeenCalledTimes(1);
      expect(signaling.client.sendOffer).toHaveBeenCalledWith("candidate-offer-sdp");
    });
    expect(
      vi.mocked(media.session.ensureEventsDataChannel).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(media.session.createOffer).mock.invocationCallOrder[0]);
    expect(screen.getByRole("button", { name: "麦克风已开启" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "摄像头已开启" })).toBeDisabled();

    act(() => {
      signaling.emit({
        kind: "joined",
        roomId: "room-created",
        role: "interviewer",
        status: "live",
      });
    });

    expect(media.session.requestLocalMedia).toHaveBeenCalledTimes(1);
    expect(media.session.ensureEventsDataChannel).toHaveBeenCalledTimes(1);
    expect(media.session.createOffer).toHaveBeenCalledTimes(1);
    expect(signaling.client.sendOffer).toHaveBeenCalledTimes(1);
  });

  it("bridges local ICE, remote answer, and remote ICE between media and signaling", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeMediaSessionFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });
    await screen.findByText("room-created");

    act(() => {
      signaling.emit({
        kind: "connected",
        roomId: "room-created",
        connectionId: "candidate-connection-1",
      });
      signaling.emit({
        kind: "joined",
        roomId: "room-created",
        role: "interviewer",
        status: "live",
      });
    });
    await waitFor(() => {
      expect(signaling.client.sendOffer).toHaveBeenCalledWith("candidate-offer-sdp");
    });

    act(() => {
      media.emitState({
        outgoingIceCandidates: [
          { candidate: "candidate:local", sdpMid: "0", sdpMLineIndex: 0 },
        ],
      });
    });
    await waitFor(() => {
      expect(signaling.client.sendIceCandidate).toHaveBeenCalledWith({
        candidate: "candidate:local",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
    });

    act(() => {
      signaling.emit({
        kind: "answer",
        roomId: "room-created",
        role: "interviewer",
        connectionId: "interviewer-connection-1",
        messageId: "answer-1",
        sentAt: 1_780_000_000_000,
        sdp: "answer-sdp",
      });
      signaling.emit({
        kind: "ice-candidate",
        roomId: "room-created",
        role: "interviewer",
        connectionId: "interviewer-connection-1",
        messageId: "ice-1",
        sentAt: 1_780_000_000_001,
        candidate: "candidate:remote",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
    });

    await waitFor(() => {
      expect(media.session.setRemoteDescription).toHaveBeenCalledWith({
        type: "answer",
        sdp: "answer-sdp",
      });
      expect(media.session.addRemoteIceCandidate).toHaveBeenCalledWith({
        candidate: "candidate:remote",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
    });
  });

  it("ignores remote media messages that are not from the interviewer", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeMediaSessionFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
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
    await waitFor(() => {
      expect(signaling.client.sendOffer).toHaveBeenCalledTimes(1);
    });

    act(() => {
      signaling.emit({
        kind: "answer",
        roomId: "room-created",
        role: "candidate",
        connectionId: "candidate-connection-1",
        messageId: "candidate-answer-1",
        sentAt: 1_780_000_000_000,
        sdp: "candidate-answer-sdp",
      });
      signaling.emit({
        kind: "ice-candidate",
        roomId: "room-created",
        role: "candidate",
        connectionId: "candidate-connection-1",
        messageId: "candidate-ice-1",
        sentAt: 1_780_000_000_001,
        candidate: "candidate:self",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
    });

    expect(screen.queryByText("连接失败")).not.toBeInTheDocument();
    expect(media.session.setRemoteDescription).not.toHaveBeenCalled();
    expect(media.session.addRemoteIceCandidate).not.toHaveBeenCalled();
  });

  it("keeps the recorder workspace visible when candidate media setup fails", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeMediaSessionFactory({
      requestLocalMedia: vi.fn().mockRejectedValue(new Error("camera denied")),
    });

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
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

    expect(await screen.findAllByText("连接失败")).toHaveLength(2);
    expect(screen.getByText("camera denied")).toBeInTheDocument();
    expect(screen.getByTestId("recorder-workspace")).toBeInTheDocument();
    expect(media.session.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the recorder workspace visible when candidate events data channel setup fails", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeMediaSessionFactory({
      ensureEventsDataChannel: vi.fn(() => {
        throw new Error("events data channel failed");
      }),
    });

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
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

    expect(await screen.findAllByText("连接失败")).toHaveLength(2);
    expect(screen.getByText("events data channel failed")).toBeInTheDocument();
    expect(screen.getByTestId("recorder-workspace")).toBeInTheDocument();
    expect(media.session.createOffer).not.toHaveBeenCalled();
    expect(media.session.close).toHaveBeenCalledTimes(1);
  });

  it("recreates candidate media when the interviewer rejoins after leaving", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const firstMedia = makeMediaSessionFactory();
    const secondMedia = makeMediaSessionFactory();
    const createMediaSession = vi
      .fn()
      .mockReturnValueOnce(firstMedia.session)
      .mockReturnValueOnce(secondMedia.session);

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession,
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
    await waitFor(() => {
      expect(firstMedia.session.requestLocalMedia).toHaveBeenCalledTimes(1);
      expect(signaling.client.sendOffer).toHaveBeenCalledTimes(1);
    });

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
    expect(firstMedia.session.close).toHaveBeenCalledTimes(1);

    act(() => {
      signaling.emit({
        kind: "joined",
        roomId: "room-created",
        role: "interviewer",
        status: "live",
      });
    });

    await waitFor(() => {
      expect(createMediaSession).toHaveBeenCalledTimes(2);
      expect(secondMedia.session.requestLocalMedia).toHaveBeenCalledTimes(1);
      expect(signaling.client.sendOffer).toHaveBeenCalledTimes(2);
    });

    act(() => {
      signaling.emit({
        kind: "answer",
        roomId: "room-created",
        role: "interviewer",
        connectionId: "interviewer-connection-1",
        messageId: "old-answer-1",
        sentAt: 1_780_000_000_001,
        sdp: "old-answer-sdp",
      });
      signaling.emit({
        kind: "ice-candidate",
        roomId: "room-created",
        role: "interviewer",
        connectionId: "interviewer-connection-1",
        messageId: "old-ice-1",
        sentAt: 1_780_000_000_002,
        candidate: "candidate:old",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
    });

    expect(screen.queryByText("连接失败")).not.toBeInTheDocument();
    expect(secondMedia.session.setRemoteDescription).not.toHaveBeenCalled();
    expect(secondMedia.session.addRemoteIceCandidate).not.toHaveBeenCalled();
  });

  it("ignores late remote media messages after the interviewer leaves", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeMediaSessionFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
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
    await waitFor(() => {
      expect(signaling.client.sendOffer).toHaveBeenCalledTimes(1);
    });

    act(() => {
      signaling.emit({
        kind: "leave",
        roomId: "room-created",
        role: "interviewer",
        connectionId: "interviewer-connection-1",
        messageId: "leave-1",
        sentAt: 1_780_000_000_000,
      });
      signaling.emit({
        kind: "answer",
        roomId: "room-created",
        role: "interviewer",
        connectionId: "interviewer-connection-1",
        messageId: "answer-1",
        sentAt: 1_780_000_000_001,
        sdp: "late-answer-sdp",
      });
      signaling.emit({
        kind: "ice-candidate",
        roomId: "room-created",
        role: "interviewer",
        connectionId: "interviewer-connection-1",
        messageId: "ice-1",
        sentAt: 1_780_000_000_002,
        candidate: "candidate:late",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
    });

    expect(screen.queryByText("连接失败")).not.toBeInTheDocument();
    expect(screen.getAllByText("等待面试官")).toHaveLength(2);
    expect(media.session.setRemoteDescription).not.toHaveBeenCalled();
    expect(media.session.addRemoteIceCandidate).not.toHaveBeenCalled();
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
    await waitFor(() => {
      expect(signaling.client.sendOffer).toHaveBeenCalledTimes(1);
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

  it("closes candidate media when the signaling socket closes after a live join", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeMediaSessionFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
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
    await waitFor(() => {
      expect(screen.getByText("面试官在线")).toBeInTheDocument();
      expect(signaling.client.sendOffer).toHaveBeenCalledTimes(1);
    });

    act(() => {
      signaling.emitError({
        code: "socket-closed",
        message: "interview signaling socket closed",
      });
    });
    expect(screen.getAllByText("连接失败")).toHaveLength(2);
    expect(screen.getByText("面试官离线")).toBeInTheDocument();
    expect(screen.getByTestId("recorder-workspace")).toBeInTheDocument();
    expect(media.session.close).toHaveBeenCalledTimes(1);
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
    const media = makeMediaSessionFactory();

    const view = renderCandidatePage({
      initialEntry: "/interview/candidate",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });
    await screen.findByText("room-created");

    view.unmount();

    expect(signaling.client.close).toHaveBeenCalledTimes(1);
    expect(media.session.close).toHaveBeenCalledTimes(1);
  });

  it("keeps routed candidate rooms in read-only recording mode without a join code", () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeMediaSessionFactory();

    renderCandidatePage({
      initialEntry: "/interview/candidate/room-route",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });

    expect(screen.getByText("room-route")).toBeInTheDocument();
    expect(screen.getByText("缺少 joinCode，当前仅展示候选人录制工作区")).toBeInTheDocument();
    expect(screen.getByTestId("recorder-workspace")).toBeInTheDocument();
    expect(roomClient.createRoom).not.toHaveBeenCalled();
    expect(signaling.create).not.toHaveBeenCalled();
    expect(media.create).not.toHaveBeenCalled();
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
  createMediaSession = makeMediaSessionFactory().create,
  strict = false,
}: {
  initialEntry: string;
  roomClient: InterviewRoomClient;
  createSignalingClient: (options: InterviewSignalingClientOptions) => InterviewSignalingClient;
  createMediaSession?: () => InterviewMediaSession;
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
              createMediaSession,
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
    eventsDataChannelState: "not-created",
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
    sendOffer: vi.fn(() => ({ ok: true as const, message: {} as never })),
    sendAnswer: vi.fn(() => ({ ok: true as const, message: {} as never })),
    sendIceCandidate: vi.fn(() => ({ ok: true as const, message: {} as never })),
    sendHeartbeat: vi.fn(() => ({ ok: true as const, message: {} as never })),
    sendLeave: vi.fn(() => ({ ok: true as const, message: {} as never })),
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

function makeMediaSessionFactory(patch: Partial<InterviewMediaSession> = {}) {
  let state = makeMediaState();
  const listeners = new Set<(next: InterviewMediaSessionState) => void>();
  const updateState = (next: Partial<InterviewMediaSessionState>) => {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener(state));
    return state;
  };
  const localStream = {} as MediaStream;
  const remoteStream = {} as MediaStream;
  const eventsDataChannel: InterviewEventsDataChannel = {
    readyState: "connecting",
    onopen: null,
    onclose: null,
    send: vi.fn(),
    close: vi.fn(),
  };
  const session: InterviewMediaSession = {
    getState: vi.fn(() => state),
    requestLocalMedia: vi.fn(async () =>
      updateState({
        localStream,
        microphoneEnabled: true,
        cameraEnabled: true,
      }),
    ),
    setMicrophoneEnabled: vi.fn((enabled) =>
      updateState({
        microphoneEnabled: enabled,
      }),
    ),
    setCameraEnabled: vi.fn((enabled) =>
      updateState({
        cameraEnabled: enabled,
      }),
    ),
    createOffer: vi.fn(async () => ({ type: "offer" as const, sdp: "candidate-offer-sdp" })),
    createAnswer: vi.fn(async () => ({ type: "answer" as const, sdp: "candidate-answer-sdp" })),
    ensureEventsDataChannel: vi.fn(() => {
      updateState({ eventsDataChannelState: eventsDataChannel.readyState });
      return eventsDataChannel;
    }),
    setRemoteDescription: vi.fn(async () => state),
    addRemoteIceCandidate: vi.fn(async () => state),
    drainOutgoingIceCandidates: vi.fn(() => {
      const candidates = state.outgoingIceCandidates;
      updateState({ outgoingIceCandidates: [] });
      return candidates;
    }),
    subscribe: vi.fn((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    close: vi.fn(() =>
      updateState({
        localStream: null,
        remoteStream: null,
        microphoneEnabled: false,
        cameraEnabled: false,
        connectionState: "closed",
        iceConnectionState: "closed",
        signalingState: "closed",
        outgoingIceCandidates: [],
      }),
    ),
    ...patch,
  };

  return {
    create: vi.fn(() => session),
    session,
    emitState(next: Partial<InterviewMediaSessionState>) {
      updateState(next);
    },
    localStream,
    remoteStream,
  };
}
