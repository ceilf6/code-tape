import { act, render, screen, waitFor } from "@testing-library/react";
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
import {
  RemoteInterviewWorkbenchPage,
  RemoteInterviewWorkbenchView,
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
    expect(screen.getAllByText("实时同步")).toHaveLength(2);

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

    expect(screen.getAllByText("等待候选人状态快照")).toHaveLength(2);
    expect(screen.getByText("缺失事件 seq 5，已保留 seq 3 的稳定状态")).toBeInTheDocument();
    expect(latestCodeEditorProps().value).toBe("const lastStable = true;");
  });

  it("renders media placeholders and disabled controls from media session state", () => {
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

    expect(screen.getByText("本地预览")).toBeInTheDocument();
    expect(screen.getByText("候选人视频")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "本地预览占位" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "候选人视频占位" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "麦克风已关闭" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "摄像头已关闭" })).toBeDisabled();
    expect(screen.getByText("WebRTC")).toBeInTheDocument();
    expect(screen.getByText("connecting")).toBeInTheDocument();
    expect(screen.getByText("ICE")).toBeInTheDocument();
    expect(screen.getByText("checking")).toBeInTheDocument();
    expect(screen.getByText("事件通道")).toBeInTheDocument();
    expect(screen.getByText("open")).toBeInTheDocument();
  });

  it("binds local and remote media streams into video elements", async () => {
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

      expect(screen.getByLabelText("本地预览画面")).toBeInTheDocument();
      expect(screen.getByLabelText("候选人视频画面")).toBeInTheDocument();
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
    expect(screen.getAllByText("实时同步")).toHaveLength(2);
    expect(screen.getByText("seq 1")).toBeInTheDocument();
    expect(screen.getByText("seq 2")).toBeInTheDocument();
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

function renderWorkbenchView(props: ComponentProps<typeof RemoteInterviewWorkbenchView>) {
  return render(
    <TooltipProvider>
      <RemoteInterviewWorkbenchView {...props} />
    </TooltipProvider>,
  );
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
