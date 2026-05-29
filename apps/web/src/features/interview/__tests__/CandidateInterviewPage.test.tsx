import { render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { appRoutes } from "@/app/routes";
import { ThemeProvider } from "@/shared/ui/themeProvider";
import { TooltipProvider } from "@/shared/ui/Tooltip";
import type { InterviewMediaSessionState } from "../interviewMediaSession";
import { CandidateInterviewView } from "../CandidateInterviewPage";

vi.mock("@/features/recorder/RecorderPage", () => ({
  RecorderPage() {
    return <div data-testid="recorder-workspace">Recorder workspace</div>;
  },
}));

describe("CandidateInterviewPage", () => {
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
