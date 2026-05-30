import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeEditorProps } from "@/features/editor/CodeEditor";
import type { RecordingEvent, ReplayStableState } from "@/shared/recording-schema";
import { ThemeProvider } from "@/shared/ui/themeProvider";
import { TooltipProvider } from "@/shared/ui/Tooltip";
import { appRoutes } from "@/app/routes";
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
import {
  RemoteInterviewWorkbenchPage,
  RemoteInterviewWorkbenchView,
  type RemoteInterviewConnectionState,
} from "../RemoteInterviewWorkbenchPage";
import type { RemoteInterviewWorkbenchState } from "../remoteInterviewWorkbench";

const codeEditorMock = vi.hoisted(() => ({
  calls: [] as CodeEditorProps[],
}));

vi.mock("@/features/editor/CodeEditor", () => ({
  CodeEditor(props: CodeEditorProps) {
    codeEditorMock.calls.push(props);
    return (
      <pre aria-label="Mock read-only code editor" data-readonly={String(props.readOnly)}>
        {props.value}
      </pre>
    );
  },
}));

vi.mock("@/features/runtime-preview/PreviewPane", () => ({
  PreviewPane: ({ previewHtml }: { previewHtml?: string | null }) => (
    <div aria-label="Mock preview pane" data-preview-html={previewHtml ?? ""} />
  ),
}));

vi.mock("@/features/runtime-preview/iframeRuntime", () => ({
  createIframeRuntime: vi.fn(() => ({})),
}));

describe("RemoteInterviewWorkbenchPage", () => {
  afterEach(() => {
    codeEditorMock.calls.length = 0;
    vi.restoreAllMocks();
  });

  it("renders the candidate editor state through a read-only editor", () => {
    const stableState = makeStableState({
      editor: {
        code: "const answer = 42;",
        language: "typescript",
        cursor: { lineNumber: 2, column: 7 },
        selection: {
          startLineNumber: 2,
          startColumn: 1,
          endLineNumber: 2,
          endColumn: 7,
        },
        scrollTop: 32,
        scrollLeft: 4,
        fontSize: 16,
        theme: "dark",
      },
    });

    renderWorkbenchView({
      roomId: "room-42",
      workbenchState: makeWorkbenchState({
        stableState,
        syncStatus: "live",
        expectedSeq: 4,
        lastAppliedSeq: 3,
      }),
      mediaState: makeMediaState(),
    });

    expect(screen.getByRole("heading", { name: "面试官工作台" })).toBeInTheDocument();
    expect(screen.getByText("room-42")).toBeInTheDocument();
    expect(screen.getByText("实时同步")).toBeInTheDocument();

    const editorProps = latestCodeEditorProps();
    expect(editorProps).toMatchObject({
      readOnly: true,
      value: "const answer = 42;",
      language: "typescript",
      fontSize: 16,
      theme: "dark",
      scrollTop: 32,
      scrollLeft: 4,
    });
    expect(editorProps.cursor).toEqual({ lineNumber: 2, column: 7 });
    expect(editorProps.selection).toEqual({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 7,
    });
  });

  it("keeps the last stable code visible while waiting for a snapshot", () => {
    renderWorkbenchView({
      roomId: "room-gap",
      workbenchState: makeWorkbenchState({
        stableState: makeStableState({ editor: { code: "const lastStable = true;" } }),
        syncStatus: "waiting-for-snapshot",
        expectedSeq: 5,
        lastAppliedSeq: 3,
        snapshotRequestNeeded: {
          reason: "gap-detected",
          expectedSeq: 5,
          lastAppliedSeq: 3,
        },
      }),
      mediaState: makeMediaState(),
    });

    expect(screen.getByText("等待候选人状态快照")).toBeInTheDocument();
    expect(screen.getByText("缺失事件 seq 5，已保留 seq 3 的稳定状态")).toBeInTheDocument();
    expect(latestCodeEditorProps().value).toBe("const lastStable = true;");
  });

  it("renders disabled device controls in the header before local media is ready", () => {
    renderWorkbenchView({
      roomId: "room-media",
      workbenchState: makeWorkbenchState(),
      mediaState: makeMediaState({
        microphoneEnabled: false,
        cameraEnabled: false,
        connectionState: "connecting",
        iceConnectionState: "checking",
        eventsDataChannelState: "open",
      }),
    });

    expect(screen.getByRole("button", { name: "麦克风已关闭" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "摄像头已关闭" })).toBeDisabled();
  });

  it("renders the synced runtime console output", () => {
    renderWorkbenchView({
      roomId: "room-runtime",
      workbenchState: makeWorkbenchState({
        stableState: makeStableState({
          runtime: {
            status: "success",
            stdout: ["hello from candidate"],
            stderr: [],
            previewHtml: null,
            errorMessage: null,
          },
        }),
      }),
      mediaState: makeMediaState(),
    });

    expect(screen.getByText("Console")).toBeInTheDocument();
    expect(screen.getByText("hello from candidate")).toBeInTheDocument();
    expect(screen.getByText("success")).toBeInTheDocument();
    expect(screen.queryByLabelText("Mock preview pane")).not.toBeInTheDocument();
  });

  it("renders the preview pane when the synced runtime has previewHtml", () => {
    renderWorkbenchView({
      roomId: "room-preview",
      workbenchState: makeWorkbenchState({
        stableState: makeStableState({
          runtime: {
            status: "success",
            stdout: [],
            stderr: [],
            previewHtml: "<p>candidate preview</p>",
            errorMessage: null,
          },
        }),
      }),
      mediaState: makeMediaState(),
    });

    const preview = screen.getByLabelText("Mock preview pane");
    expect(preview).toHaveAttribute("data-preview-html", "<p>candidate preview</p>");
  });

  it("toggles the interviewer's own microphone and camera once local media is ready", () => {
    const onToggleMicrophone = vi.fn();
    const onToggleCamera = vi.fn();
    const localStream = { id: "local" } as unknown as MediaStream;

    renderWorkbenchView({
      roomId: "room-devices",
      workbenchState: makeWorkbenchState(),
      mediaState: makeMediaState({ localStream }),
      onToggleMicrophone,
      onToggleCamera,
    });

    const micButton = screen.getByRole("button", { name: "麦克风已关闭" });
    const cameraButton = screen.getByRole("button", { name: "摄像头已关闭" });
    expect(micButton).toBeEnabled();
    expect(cameraButton).toBeEnabled();

    fireEvent.click(micButton);
    fireEvent.click(cameraButton);

    expect(onToggleMicrophone).toHaveBeenCalledWith(true);
    expect(onToggleCamera).toHaveBeenCalledWith(true);
  });

  it("keeps device controls disabled until local media is acquired", () => {
    renderWorkbenchView({
      roomId: "room-no-media",
      workbenchState: makeWorkbenchState(),
      mediaState: makeMediaState({ localStream: null }),
      onToggleMicrophone: vi.fn(),
      onToggleCamera: vi.fn(),
    });

    expect(screen.getByRole("button", { name: "麦克风已关闭" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "摄像头已关闭" })).toBeDisabled();
  });

  it("binds remote stream to an unmuted video and local stream to a muted preview", async () => {
    const originalSrcObjectDescriptor = Object.getOwnPropertyDescriptor(
      HTMLVideoElement.prototype,
      "srcObject",
    );
    const setSrcObject = vi.fn();
    Object.defineProperty(HTMLVideoElement.prototype, "srcObject", {
      configurable: true,
      set: setSrcObject,
    });
    const localStream = { id: "local-stream" } as unknown as MediaStream;
    const remoteStream = { id: "remote-stream" } as unknown as MediaStream;

    try {
      renderWorkbenchView({
        roomId: "room-streams",
        workbenchState: makeWorkbenchState(),
        mediaState: makeMediaState({
          localStream,
          remoteStream,
          microphoneEnabled: true,
          cameraEnabled: true,
        }),
      });

      const remoteVideo = screen.getByLabelText("候选人视频画面") as HTMLVideoElement;
      const localVideo = screen.getByLabelText("本地预览画面") as HTMLVideoElement;
      // Candidate audio must be audible to the interviewer.
      expect(remoteVideo.muted).toBe(false);
      // Local self-preview is muted to avoid echo.
      expect(localVideo.muted).toBe(true);
      await waitFor(() => {
        expect(setSrcObject).toHaveBeenCalledWith(localStream);
        expect(setSrcObject).toHaveBeenCalledWith(remoteStream);
      });
    } finally {
      if (originalSrcObjectDescriptor) {
        Object.defineProperty(
          HTMLVideoElement.prototype,
          "srcObject",
          originalSrcObjectDescriptor,
        );
      } else {
        Reflect.deleteProperty(HTMLVideoElement.prototype, "srcObject");
      }
    }
  });

  it("registers the interviewer workbench route", () => {
    const router = createMemoryRouter(appRoutes, {
      initialEntries: ["/interview/interviewer/room-route"],
    });

    render(
      <ThemeProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </ThemeProvider>,
    );

    expect(screen.getByRole("heading", { name: "面试官工作台" })).toBeInTheDocument();
    expect(screen.getByText("room-route")).toBeInTheDocument();
  });

  it("applies recording-event messages from the events DataChannel to the read-only workbench", async () => {
    const media = createFakeMediaSession();
    const router = createMemoryRouter(
      [
        {
          path: "/interview/interviewer/:roomId",
          element: (
            <RemoteInterviewWorkbenchPage
              deps={{ createMediaSession: () => media.session }}
            />
          ),
        },
      ],
      {
        initialEntries: ["/interview/interviewer/room-live"],
      },
    );

    render(
      <ThemeProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </ThemeProvider>,
    );

    let channel!: TestEventsDataChannel;
    act(() => {
      channel = media.attachEventsDataChannel();
    });

    act(() => {
      channel.emit(JSON.stringify(recordingMessage(contentEvent(1, "const fromCandidate = true;"))));
    });

    await waitFor(() => {
      expect(latestCodeEditorProps().value).toBe("const fromCandidate = true;");
    });
    expect(latestCodeEditorProps().readOnly).toBe(true);
    expect(screen.getByText("实时同步")).toBeInTheDocument();
    expect(screen.getByText("applied seq 1")).toBeInTheDocument();
    expect(screen.getByText("next seq 2")).toBeInTheDocument();
  });

  it("detaches the DataChannel receiver when the interviewer workbench unmounts", () => {
    const media = createFakeMediaSession();
    const router = createMemoryRouter(
      [
        {
          path: "/interview/interviewer/:roomId",
          element: (
            <RemoteInterviewWorkbenchPage
              deps={{ createMediaSession: () => media.session }}
            />
          ),
        },
      ],
      {
        initialEntries: ["/interview/interviewer/room-live"],
      },
    );

    const { unmount } = render(
      <ThemeProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    let channel!: TestEventsDataChannel;
    act(() => {
      channel = media.attachEventsDataChannel();
    });

    expect(channel.onmessage).not.toBeNull();
    unmount();

    expect(channel.onmessage).toBeNull();
    expect(media.session.close).toHaveBeenCalledTimes(1);
  });

  it("detaches the DataChannel receiver when the events channel closes", () => {
    const media = createFakeMediaSession();
    const router = createMemoryRouter(
      [
        {
          path: "/interview/interviewer/:roomId",
          element: (
            <RemoteInterviewWorkbenchPage
              deps={{ createMediaSession: () => media.session }}
            />
          ),
        },
      ],
      {
        initialEntries: ["/interview/interviewer/room-live"],
      },
    );

    render(
      <ThemeProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    let channel!: TestEventsDataChannel;
    act(() => {
      channel = media.attachEventsDataChannel();
    });

    expect(channel.onmessage).not.toBeNull();
    act(() => {
      media.closeEventsDataChannel();
    });
    channel.emit(JSON.stringify(recordingMessage(contentEvent(1, "const ignored = true;"))));

    expect(channel.onmessage).toBeNull();
    expect(latestCodeEditorProps().value).toBe("");
  });

  it("resets room-scoped workbench and media session when the route room changes", async () => {
    const firstMedia = createFakeMediaSession();
    const secondMedia = createFakeMediaSession();
    const createMediaSession = vi
      .fn<() => InterviewMediaSession>()
      .mockReturnValueOnce(firstMedia.session)
      .mockReturnValueOnce(secondMedia.session);
    const router = createMemoryRouter(
      [
        {
          path: "/interview/interviewer/:roomId",
          element: (
            <RemoteInterviewWorkbenchPage
              deps={{ createMediaSession }}
            />
          ),
        },
      ],
      {
        initialEntries: ["/interview/interviewer/room-a"],
      },
    );

    render(
      <ThemeProvider>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    let firstChannel!: TestEventsDataChannel;
    act(() => {
      firstChannel = firstMedia.attachEventsDataChannel();
      firstChannel.emit(
        JSON.stringify(recordingMessage(contentEvent(1, "const roomA = true;"), "room-a")),
      );
    });
    await waitFor(() => {
      expect(latestCodeEditorProps().value).toBe("const roomA = true;");
    });

    await act(async () => {
      await router.navigate("/interview/interviewer/room-b");
    });

    expect(firstMedia.session.close).toHaveBeenCalledTimes(1);
    expect(firstChannel.onmessage).toBeNull();
    expect(screen.getByText("room-b")).toBeInTheDocument();
    expect(latestCodeEditorProps().value).toBe("");

    act(() => {
      firstChannel.emit(
        JSON.stringify(recordingMessage(contentEvent(2, "const stale = true;"), "room-a")),
      );
    });
    expect(latestCodeEditorProps().value).toBe("");

    act(() => {
      const secondChannel = secondMedia.attachEventsDataChannel();
      secondChannel.emit(
        JSON.stringify(recordingMessage(contentEvent(1, "const roomB = true;"), "room-b")),
      );
    });
    await waitFor(() => {
      expect(latestCodeEditorProps().value).toBe("const roomB = true;");
    });
    expect(createMediaSession).toHaveBeenCalledTimes(2);
  });
});

function latestCodeEditorProps(): CodeEditorProps {
  const props = codeEditorMock.calls.at(-1);
  if (!props) {
    throw new Error("CodeEditor was not rendered");
  }
  return props;
}

describe("RemoteInterviewWorkbenchPage interviewer signaling", () => {
  afterEach(() => {
    codeEditorMock.calls.length = 0;
    vi.restoreAllMocks();
  });

  it("validates the room and joins as interviewer once signaling connects", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeInterviewerMediaSessionFactory();

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=JOIN1234",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });

    await waitFor(() => {
      expect(roomClient.getRoom).toHaveBeenCalledWith("room-live", "JOIN1234");
      expect(signaling.create).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: "room-live",
          role: "interviewer",
          joinCode: "JOIN1234",
          signalingUrl: "/api/interviews/rooms/room-live/signaling",
        }),
      );
    });

    act(() => {
      signaling.emit({
        kind: "connected",
        roomId: "room-live",
        connectionId: "interviewer-connection-1",
      });
    });

    expect(signaling.client.sendJoin).toHaveBeenCalledTimes(1);
  });

  it("answers the candidate offer, then bridges local and remote ICE", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeInterviewerMediaSessionFactory();

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=JOIN1234",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });
    await waitFor(() => {
      expect(signaling.create).toHaveBeenCalledTimes(1);
    });

    act(() => {
      signaling.emit({
        kind: "offer",
        roomId: "room-live",
        role: "candidate",
        connectionId: "candidate-connection-1",
        messageId: "offer-1",
        sentAt: 1_780_000_000_000,
        sdp: "candidate-offer-sdp",
      });
    });

    await waitFor(() => {
      expect(media.session.requestLocalMedia).toHaveBeenCalledTimes(1);
      expect(media.session.setRemoteDescription).toHaveBeenCalledWith({
        type: "offer",
        sdp: "candidate-offer-sdp",
      });
      expect(media.session.createAnswer).toHaveBeenCalledTimes(1);
      expect(signaling.client.sendAnswer).toHaveBeenCalledWith("interviewer-answer-sdp");
    });
    expect(
      vi.mocked(media.session.setRemoteDescription).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(media.session.createAnswer).mock.invocationCallOrder[0]);

    act(() => {
      media.emitState({
        outgoingIceCandidates: [
          { candidate: "candidate:interviewer-local", sdpMid: "0", sdpMLineIndex: 0 },
        ],
      });
    });
    await waitFor(() => {
      expect(signaling.client.sendIceCandidate).toHaveBeenCalledWith({
        candidate: "candidate:interviewer-local",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
    });

    act(() => {
      signaling.emit({
        kind: "ice-candidate",
        roomId: "room-live",
        role: "candidate",
        connectionId: "candidate-connection-1",
        messageId: "ice-1",
        sentAt: 1_780_000_000_001,
        candidate: "candidate:candidate-remote",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
    });
    await waitFor(() => {
      expect(media.session.addRemoteIceCandidate).toHaveBeenCalledWith({
        candidate: "candidate:candidate-remote",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
    });
  });

  it("keeps applying recording-event messages from the candidate events channel after answering", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeInterviewerMediaSessionFactory();

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=JOIN1234",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });
    await waitFor(() => {
      expect(signaling.create).toHaveBeenCalledTimes(1);
    });

    act(() => {
      signaling.emit({
        kind: "offer",
        roomId: "room-live",
        role: "candidate",
        connectionId: "candidate-connection-1",
        messageId: "offer-1",
        sentAt: 1_780_000_000_000,
        sdp: "candidate-offer-sdp",
      });
    });
    await waitFor(() => {
      expect(signaling.client.sendAnswer).toHaveBeenCalledTimes(1);
    });

    act(() => {
      const channel = media.attachEventsDataChannel();
      channel.emit(
        JSON.stringify(recordingMessage(contentEvent(1, "const fromCandidate = true;"))),
      );
    });

    await waitFor(() => {
      expect(latestCodeEditorProps().value).toBe("const fromCandidate = true;");
    });
    expect(latestCodeEditorProps().readOnly).toBe(true);
  });

  it("sends a snapshot-request over the events channel when a seq gap appears", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeInterviewerMediaSessionFactory();

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=JOIN1234",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });
    await waitFor(() => {
      expect(signaling.create).toHaveBeenCalledTimes(1);
    });

    let channel!: TestEventsDataChannel;
    act(() => {
      channel = media.attachEventsDataChannel();
      // seq 2 arrives while expecting seq 1 -> buffer reports a gap.
      channel.emit(JSON.stringify(recordingMessage(contentEvent(2, "const gapped = true;"))));
    });

    await waitFor(() => {
      const requests = vi
        .mocked(channel.send)
        .mock.calls.map(([data]) => JSON.parse(data))
        .filter((message) => message.kind === "snapshot-request");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        roomId: "room-live",
        reason: "gap-timeout",
        expectedSeq: 1,
        lastAppliedSeq: 0,
      });
    });

    // The same unchanged gap must not trigger a duplicate request.
    act(() => {
      channel.emit(JSON.stringify(recordingMessage(contentEvent(3, "const stillGapped = true;"))));
    });
    const requestCount = vi
      .mocked(channel.send)
      .mock.calls.map(([data]) => JSON.parse(data))
      .filter((message) => message.kind === "snapshot-request").length;
    expect(requestCount).toBe(1);
  });

  it("ignores cross-room and non-candidate media messages", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeInterviewerMediaSessionFactory();

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=JOIN1234",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });
    await waitFor(() => {
      expect(signaling.create).toHaveBeenCalledTimes(1);
    });

    act(() => {
      signaling.emit({
        kind: "offer",
        roomId: "other-room",
        role: "candidate",
        connectionId: "candidate-connection-1",
        messageId: "offer-other-room",
        sentAt: 1_780_000_000_000,
        sdp: "cross-room-offer-sdp",
      });
      signaling.emit({
        kind: "offer",
        roomId: "room-live",
        role: "interviewer",
        connectionId: "interviewer-connection-2",
        messageId: "offer-wrong-role",
        sentAt: 1_780_000_000_001,
        sdp: "wrong-role-offer-sdp",
      });
    });

    expect(media.session.setRemoteDescription).not.toHaveBeenCalled();
    expect(media.session.createAnswer).not.toHaveBeenCalled();
    expect(signaling.client.sendAnswer).not.toHaveBeenCalled();
  });

  it("surfaces a failed connection and skips the answer when media permission is denied", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeInterviewerMediaSessionFactory({
      requestLocalMedia: vi.fn().mockRejectedValue(new Error("camera denied")),
    });

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=JOIN1234",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });
    await waitFor(() => {
      expect(signaling.create).toHaveBeenCalledTimes(1);
    });

    act(() => {
      signaling.emit({
        kind: "offer",
        roomId: "room-live",
        role: "candidate",
        connectionId: "candidate-connection-1",
        messageId: "offer-1",
        sentAt: 1_780_000_000_000,
        sdp: "candidate-offer-sdp",
      });
    });

    expect(await screen.findByText("camera denied")).toBeInTheDocument();
    expect(media.session.createAnswer).not.toHaveBeenCalled();
    expect(signaling.client.sendAnswer).not.toHaveBeenCalled();
  });

  it("exposes an error and skips signaling when the join code is missing", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeInterviewerMediaSessionFactory();

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });

    expect(await screen.findByText("缺少 joinCode，无法加入面试房间")).toBeInTheDocument();
    expect(roomClient.getRoom).not.toHaveBeenCalled();
    expect(signaling.create).not.toHaveBeenCalled();
  });

  it("exposes an error when room validation fails", async () => {
    const roomClient = makeRoomClient({
      getRoom: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: "invalid-join-code", message: "join code is invalid" },
      }),
    });
    const signaling = makeSignalingFactory();
    const media = makeInterviewerMediaSessionFactory();

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=BADCODE0",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });

    expect(await screen.findByText("join code is invalid")).toBeInTheDocument();
    expect(signaling.create).not.toHaveBeenCalled();
  });

  it("exposes an error when the signaling client reports an error", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeInterviewerMediaSessionFactory();

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=JOIN1234",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });
    await waitFor(() => {
      expect(signaling.create).toHaveBeenCalledTimes(1);
    });

    act(() => {
      signaling.emitError({
        code: "socket-closed",
        message: "interview signaling socket closed",
      });
    });

    expect(await screen.findByText("interview signaling socket closed")).toBeInTheDocument();
    expect(media.session.close).toHaveBeenCalledTimes(1);
  });

  it("closes media when the signaling socket fails after answering an offer", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeInterviewerMediaSessionFactory();

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=JOIN1234",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });
    await waitFor(() => {
      expect(signaling.create).toHaveBeenCalledTimes(1);
    });

    act(() => {
      signaling.emit({
        kind: "offer",
        roomId: "room-live",
        role: "candidate",
        connectionId: "candidate-connection-1",
        messageId: "offer-1",
        sentAt: 1_780_000_000_000,
        sdp: "candidate-offer-sdp",
      });
    });
    await waitFor(() => {
      expect(signaling.client.sendAnswer).toHaveBeenCalledTimes(1);
    });

    act(() => {
      signaling.emitError({
        code: "socket-closed",
        message: "interview signaling socket closed",
      });
    });

    expect(await screen.findByText("interview signaling socket closed")).toBeInTheDocument();
    expect(media.session.close).toHaveBeenCalledTimes(1);
    expect(signaling.client.close).toHaveBeenCalledTimes(1);
  });

  it("closes signaling and media session when the interviewer page unmounts", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeInterviewerMediaSessionFactory();

    const view = renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=JOIN1234",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });
    await waitFor(() => {
      expect(signaling.create).toHaveBeenCalledTimes(1);
    });

    view.unmount();

    expect(signaling.client.close).toHaveBeenCalledTimes(1);
    expect(media.session.close).toHaveBeenCalledTimes(1);
  });

  it("ignores stale signaling messages emitted after the page unmounts", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeInterviewerMediaSessionFactory();

    const view = renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=JOIN1234",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });
    await waitFor(() => {
      expect(signaling.create).toHaveBeenCalledTimes(1);
    });

    view.unmount();
    vi.mocked(signaling.client.sendJoin).mockClear();

    act(() => {
      signaling.emit({
        kind: "connected",
        roomId: "room-live",
        connectionId: "interviewer-connection-1",
      });
      signaling.emit({
        kind: "offer",
        roomId: "room-live",
        role: "candidate",
        connectionId: "candidate-connection-late",
        messageId: "offer-late",
        sentAt: 1_780_000_000_000,
        sdp: "late-offer-sdp",
      });
    });

    expect(signaling.client.sendJoin).not.toHaveBeenCalled();
    expect(media.session.requestLocalMedia).not.toHaveBeenCalled();
    expect(media.session.setRemoteDescription).not.toHaveBeenCalled();
    expect(signaling.client.sendAnswer).not.toHaveBeenCalled();
  });

  it("rejects a malformed join code locally without validating the room", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeInterviewerMediaSessionFactory();

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=SHORT",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });

    expect(
      await screen.findByText("joinCode 格式非法，无法加入面试房间"),
    ).toBeInTheDocument();
    expect(roomClient.getRoom).not.toHaveBeenCalled();
    expect(signaling.create).not.toHaveBeenCalled();
  });

  it("buffers candidate ICE until the remote offer description is applied", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    let resolveLocalMedia: (() => void) | null = null;
    const media = makeInterviewerMediaSessionFactory({
      requestLocalMedia: vi.fn(
        () =>
          new Promise<InterviewMediaSessionState>((resolve) => {
            resolveLocalMedia = () =>
              resolve({
                localStream: null,
                remoteStream: null,
                microphoneEnabled: true,
                cameraEnabled: true,
                connectionState: "new",
                iceConnectionState: "new",
                signalingState: "stable",
                outgoingIceCandidates: [],
                eventsDataChannelState: "not-created",
              });
          }),
      ),
    });

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=JOIN1234",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });
    await waitFor(() => {
      expect(signaling.create).toHaveBeenCalledTimes(1);
    });

    act(() => {
      signaling.emit({
        kind: "offer",
        roomId: "room-live",
        role: "candidate",
        connectionId: "candidate-connection-1",
        messageId: "offer-1",
        sentAt: 1_780_000_000_000,
        sdp: "candidate-offer-sdp",
      });
      signaling.emit({
        kind: "ice-candidate",
        roomId: "room-live",
        role: "candidate",
        connectionId: "candidate-connection-1",
        messageId: "ice-early",
        sentAt: 1_780_000_000_001,
        candidate: "candidate:early",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
    });

    expect(media.session.addRemoteIceCandidate).not.toHaveBeenCalled();

    await act(async () => {
      resolveLocalMedia?.();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(media.session.setRemoteDescription).toHaveBeenCalledWith({
        type: "offer",
        sdp: "candidate-offer-sdp",
      });
      expect(media.session.addRemoteIceCandidate).toHaveBeenCalledWith({
        candidate: "candidate:early",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
    });
    expect(screen.queryByText("连接失败")).not.toBeInTheDocument();
  });

  it("rebuilds the media session for a replacement candidate after the previous candidate leaves", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const firstMedia = makeInterviewerMediaSessionFactory();
    const secondMedia = makeInterviewerMediaSessionFactory();
    const createMediaSession = vi
      .fn<() => InterviewMediaSession>()
      .mockReturnValueOnce(firstMedia.session)
      .mockReturnValueOnce(secondMedia.session);

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=JOIN1234",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession,
    });
    await waitFor(() => {
      expect(signaling.create).toHaveBeenCalledTimes(1);
    });

    act(() => {
      signaling.emit({
        kind: "offer",
        roomId: "room-live",
        role: "candidate",
        connectionId: "candidate-connection-1",
        messageId: "offer-1",
        sentAt: 1_780_000_000_000,
        sdp: "first-offer-sdp",
      });
    });
    await waitFor(() => {
      expect(firstMedia.session.setRemoteDescription).toHaveBeenCalledWith({
        type: "offer",
        sdp: "first-offer-sdp",
      });
      expect(signaling.client.sendAnswer).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      signaling.emit({
        kind: "leave",
        roomId: "room-live",
        role: "candidate",
        connectionId: "candidate-connection-1",
        messageId: "leave-1",
        sentAt: 1_780_000_000_001,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(createMediaSession).toHaveBeenCalledTimes(2);
      expect(firstMedia.session.close).toHaveBeenCalledTimes(1);
      expect(signaling.create).toHaveBeenCalledTimes(2);
    });

    act(() => {
      signaling.emit({
        kind: "offer",
        roomId: "room-live",
        role: "candidate",
        connectionId: "candidate-connection-2",
        messageId: "offer-2",
        sentAt: 1_780_000_000_002,
        sdp: "second-offer-sdp",
      });
    });

    await waitFor(() => {
      expect(secondMedia.session.setRemoteDescription).toHaveBeenCalledWith({
        type: "offer",
        sdp: "second-offer-sdp",
      });
    });
    expect(firstMedia.session.setRemoteDescription).toHaveBeenCalledTimes(1);
  });

  it("closes signaling and media when the candidate ends the room", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeInterviewerMediaSessionFactory();

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=JOIN1234",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });
    await waitFor(() => {
      expect(signaling.create).toHaveBeenCalledTimes(1);
    });

    act(() => {
      signaling.emit({ kind: "ended", roomId: "room-live" });
    });

    expect(await screen.findByText("面试房间已结束")).toBeInTheDocument();
    expect(media.session.close).toHaveBeenCalledTimes(1);
    expect(signaling.client.close).toHaveBeenCalledTimes(1);
  });

  it("does not let an orphan candidate ICE claim the connection and block a real offer", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeInterviewerMediaSessionFactory();

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=JOIN1234",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });
    await waitFor(() => {
      expect(signaling.create).toHaveBeenCalledTimes(1);
    });

    act(() => {
      signaling.emit({
        kind: "ice-candidate",
        roomId: "room-live",
        role: "candidate",
        connectionId: "stale-candidate",
        messageId: "stale-ice",
        sentAt: 1_780_000_000_000,
        candidate: "candidate:stale",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
    });
    expect(media.session.addRemoteIceCandidate).not.toHaveBeenCalled();

    act(() => {
      signaling.emit({
        kind: "offer",
        roomId: "room-live",
        role: "candidate",
        connectionId: "real-candidate",
        messageId: "real-offer",
        sentAt: 1_780_000_000_001,
        sdp: "real-offer-sdp",
      });
    });

    await waitFor(() => {
      expect(media.session.setRemoteDescription).toHaveBeenCalledWith({
        type: "offer",
        sdp: "real-offer-sdp",
      });
      expect(signaling.client.sendAnswer).toHaveBeenCalledTimes(1);
    });
    expect(media.session.addRemoteIceCandidate).not.toHaveBeenCalledWith(
      expect.objectContaining({ candidate: "candidate:stale" }),
    );
  });

  it("ignores stale offer and ICE after the room has ended", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();
    const media = makeInterviewerMediaSessionFactory();

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=JOIN1234",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: media.create,
    });
    await waitFor(() => {
      expect(signaling.create).toHaveBeenCalledTimes(1);
    });

    act(() => {
      signaling.emit({ kind: "ended", roomId: "room-live" });
    });
    await screen.findByText("面试房间已结束");

    act(() => {
      signaling.emit({
        kind: "offer",
        roomId: "room-live",
        role: "candidate",
        connectionId: "late-candidate",
        messageId: "late-offer",
        sentAt: 1_780_000_000_002,
        sdp: "late-offer-sdp",
      });
      signaling.emit({
        kind: "ice-candidate",
        roomId: "room-live",
        role: "candidate",
        connectionId: "late-candidate",
        messageId: "late-ice",
        sentAt: 1_780_000_000_003,
        candidate: "candidate:late",
        sdpMid: "0",
        sdpMLineIndex: 0,
      });
    });

    expect(media.session.requestLocalMedia).not.toHaveBeenCalled();
    expect(media.session.setRemoteDescription).not.toHaveBeenCalled();
    expect(media.session.addRemoteIceCandidate).not.toHaveBeenCalled();
    expect(signaling.client.sendAnswer).not.toHaveBeenCalled();
    expect(screen.getByText("面试房间已结束")).toBeInTheDocument();
  });

  it("surfaces a failed connection when WebRTC media session creation throws", async () => {
    const roomClient = makeRoomClient();
    const signaling = makeSignalingFactory();

    renderInterviewerPage({
      initialEntry: "/interview/interviewer/room-live?joinCode=JOIN1234",
      roomClient,
      createSignalingClient: signaling.create,
      createMediaSession: () => {
        throw new Error("RTCPeerConnection is not available in this environment");
      },
    });

    expect(
      await screen.findByText("当前环境不支持 WebRTC，无法建立面试音视频连接"),
    ).toBeInTheDocument();
    expect(roomClient.getRoom).not.toHaveBeenCalled();
    expect(signaling.create).not.toHaveBeenCalled();
  });
});

function renderInterviewerPage({
  initialEntry,
  roomClient,
  createSignalingClient,
  createMediaSession,
}: {
  initialEntry: string;
  roomClient: InterviewRoomClient;
  createSignalingClient: (options: InterviewSignalingClientOptions) => InterviewSignalingClient;
  createMediaSession: () => InterviewMediaSession;
}) {
  const router = createMemoryRouter(
    [
      {
        path: "/interview/interviewer/:roomId",
        element: (
          <RemoteInterviewWorkbenchPage
            deps={{ roomClient, createSignalingClient, createMediaSession }}
          />
        ),
      },
    ],
    { initialEntries: [initialEntry] },
  );

  return render(
    <ThemeProvider>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </ThemeProvider>,
  );
}

function makeRoomClient(patch: Partial<InterviewRoomClient> = {}): InterviewRoomClient {
  return {
    createRoom: vi.fn(),
    getRoom: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        roomId: "room-live",
        status: "connecting",
        expiresAt: "2026-05-29T17:00:00.000Z",
        candidateConnected: true,
        interviewerConnected: false,
        signalingUrl: "/api/interviews/rooms/room-live/signaling",
      },
    }),
    endRoom: vi.fn(),
    ...patch,
  };
}

function makeSignalingFactory() {
  let onMessage: ((message: InboundSignalingMessage) => void) | undefined;
  let onError: InterviewSignalingClientOptions["onError"] | undefined;
  const client: InterviewSignalingClient = {
    socket: {} as InterviewSignalingClient["socket"],
    getConnectionId: vi.fn(() => "interviewer-connection-1"),
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

function makeInterviewerMediaSessionFactory(patch: Partial<InterviewMediaSession> = {}) {
  let state = makeMediaState();
  let channel: TestEventsDataChannel | null = null;
  const listeners = new Set<(next: InterviewMediaSessionState) => void>();
  const updateState = (next: Partial<InterviewMediaSessionState>) => {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener({ ...state }));
    return { ...state };
  };
  const localStream = { id: "interviewer-local" } as unknown as MediaStream;
  const session: InterviewMediaSession = {
    getState: vi.fn(() => ({ ...state })),
    getEventsDataChannel: vi.fn(() => channel),
    requestLocalMedia: vi.fn(async () =>
      updateState({ localStream, microphoneEnabled: true, cameraEnabled: true }),
    ),
    setMicrophoneEnabled: vi.fn(() => ({ ...state })),
    setCameraEnabled: vi.fn(() => ({ ...state })),
    ensureEventsDataChannel: vi.fn(() => {
      throw new Error("interviewer does not create the events data channel");
    }),
    createOffer: vi.fn(async () => ({ type: "offer" as const, sdp: "interviewer-offer-sdp" })),
    createAnswer: vi.fn(async () => ({ type: "answer" as const, sdp: "interviewer-answer-sdp" })),
    setRemoteDescription: vi.fn(async () => ({ ...state })),
    addRemoteIceCandidate: vi.fn(async () => ({ ...state })),
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
        eventsDataChannelState: "closed",
      }),
    ),
    ...patch,
  };

  return {
    session,
    create: vi.fn(() => session),
    emitState(next: Partial<InterviewMediaSessionState>) {
      updateState(next);
    },
    attachEventsDataChannel() {
      channel = createFakeEventsChannel();
      updateState({ eventsDataChannelState: "open" });
      return channel;
    },
  };
}

function renderWorkbenchView(
  props: Omit<ComponentProps<typeof RemoteInterviewWorkbenchView>, "connectionState"> & {
    connectionState?: RemoteInterviewConnectionState;
  },
) {
  return render(
    <TooltipProvider>
      <RemoteInterviewWorkbenchView
        connectionState={props.connectionState ?? makeConnectionState()}
        {...props}
      />
    </TooltipProvider>,
  );
}

function makeConnectionState(
  patch: Partial<RemoteInterviewConnectionState> = {},
): RemoteInterviewConnectionState {
  return { status: "joined", errorMessage: null, ...patch };
}

function makeWorkbenchState(
  patch: Partial<RemoteInterviewWorkbenchState> = {},
): RemoteInterviewWorkbenchState {
  return {
    stableState: makeStableState(),
    expectedSeq: 1,
    lastAppliedSeq: 0,
    syncStatus: "idle",
    snapshotRequestNeeded: null,
    ...patch,
  };
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

function makeStableState(
  patch: {
    editor?: Partial<ReplayStableState["editor"]>;
    media?: Partial<ReplayStableState["media"]>;
    runtime?: Partial<ReplayStableState["runtime"]>;
  } = {},
): ReplayStableState {
  return {
    editor: {
      code: "",
      language: "typescript",
      cursor: null,
      selection: null,
      scrollTop: 0,
      scrollLeft: 0,
      fontSize: 14,
      theme: "dark",
      ...patch.editor,
    },
    pointer: null,
    media: {
      microphoneEnabled: false,
      cameraEnabled: false,
      cameraPosition: { x: 0, y: 0 },
      ...patch.media,
    },
    runtime: {
      status: "idle",
      stdout: [],
      stderr: [],
      previewHtml: null,
      errorMessage: null,
      ...patch.runtime,
    },
  };
}

type TestEventsDataChannel = InterviewEventsDataChannel & {
  readyState: RTCDataChannelState;
  onmessage: ((event: { data: unknown }) => void) | null;
  closeFromRemote(): void;
  emit(data: unknown): void;
};

function createFakeMediaSession(): {
  session: InterviewMediaSession;
  attachEventsDataChannel(): TestEventsDataChannel;
  closeEventsDataChannel(): void;
} {
  let state = makeMediaState();
  let channel: TestEventsDataChannel | null = null;
  const listeners = new Set<(next: InterviewMediaSessionState) => void>();
  const notify = () => listeners.forEach((listener) => listener({ ...state }));
  const session = {
    getState: () => ({ ...state }),
    getEventsDataChannel: () => channel,
    requestLocalMedia: vi.fn(),
    setMicrophoneEnabled: vi.fn(),
    setCameraEnabled: vi.fn(),
    ensureEventsDataChannel: vi.fn(),
    createOffer: vi.fn(),
    createAnswer: vi.fn(),
    setRemoteDescription: vi.fn(),
    addRemoteIceCandidate: vi.fn(),
    drainOutgoingIceCandidates: vi.fn(() => []),
    subscribe(listener: (next: InterviewMediaSessionState) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: vi.fn(),
  } as unknown as InterviewMediaSession;

  return {
    session,
    attachEventsDataChannel() {
      channel = createFakeEventsChannel();
      state = { ...state, eventsDataChannelState: "open" };
      notify();
      return channel;
    },
    closeEventsDataChannel() {
      if (!channel) {
        return;
      }
      channel.closeFromRemote();
      state = { ...state, eventsDataChannelState: "closed" };
      notify();
    },
  };
}

function createFakeEventsChannel(): TestEventsDataChannel {
  return {
    label: "events",
    readyState: "open",
    onopen: null,
    onclose: null,
    onmessage: null,
    send: vi.fn(),
    close: vi.fn(),
    closeFromRemote() {
      this.readyState = "closed";
      this.onclose?.();
    },
    emit(data) {
      this.onmessage?.({ data });
    },
  };
}

function recordingMessage(event: RecordingEvent, roomId = "room-live") {
  return {
    kind: "recording-event" as const,
    roomId,
    sessionId: "session-1",
    messageId: `message-${event.seq}`,
    sentAt: 1_000 + event.seq,
    stateVersion: event.seq,
    event,
  };
}

function contentEvent(seq: number, code: string): RecordingEvent {
  return {
    id: `event-${seq}`,
    seq,
    timestampMs: seq * 100,
    source: "editor",
    track: "main",
    type: "content-change",
    payload: {
      fileId: "main",
      version: seq,
      code,
      contentHash: `hash-${seq}`,
      language: "typescript",
      changeReason: "input",
      changeCount: 1,
      flushedBy: "debounce",
    },
  };
}
