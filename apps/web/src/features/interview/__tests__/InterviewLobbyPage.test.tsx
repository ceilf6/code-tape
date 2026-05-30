import { render, screen, fireEvent } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, useParams } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "@/shared/ui/themeProvider";
import { TooltipProvider } from "@/shared/ui/Tooltip";
import { InterviewLobbyPage } from "../InterviewLobbyPage";
import { parseInterviewerLink } from "../interviewerLink";

describe("parseInterviewerLink", () => {
  it("parses a full interviewer URL with origin", () => {
    expect(
      parseInterviewerLink(
        "http://localhost:3000/interview/interviewer/room-abc?joinCode=JOIN1234",
      ),
    ).toEqual({ ok: true, roomId: "room-abc", joinCode: "JOIN1234" });
  });

  it("parses a relative interviewer path", () => {
    expect(parseInterviewerLink("/interview/interviewer/room-1?joinCode=ABCD5678")).toEqual({
      ok: true,
      roomId: "room-1",
      joinCode: "ABCD5678",
    });
  });

  it("parses a link served under a deployment basename", () => {
    expect(
      parseInterviewerLink(
        "https://host.example/code-tape/interview/interviewer/room-1?joinCode=JOIN1234",
      ),
    ).toEqual({ ok: true, roomId: "room-1", joinCode: "JOIN1234" });
  });

  it("parses a basename-prefixed relative path", () => {
    expect(
      parseInterviewerLink("/code-tape/interview/interviewer/room-1?joinCode=JOIN1234"),
    ).toEqual({ ok: true, roomId: "room-1", joinCode: "JOIN1234" });
  });

  it("decodes an encoded room id", () => {
    expect(
      parseInterviewerLink("/interview/interviewer/room%2F1?joinCode=ABCD5678"),
    ).toEqual({ ok: true, roomId: "room/1", joinCode: "ABCD5678" });
  });

  it("rejects an empty input", () => {
    expect(parseInterviewerLink("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects a link without joinCode", () => {
    expect(parseInterviewerLink("/interview/interviewer/room-1")).toEqual({
      ok: false,
      reason: "missing-join-code",
    });
  });

  it("rejects a malformed joinCode", () => {
    expect(
      parseInterviewerLink("/interview/interviewer/room-1?joinCode=SHORT"),
    ).toEqual({ ok: false, reason: "invalid-join-code" });
  });

  it("rejects a non-interviewer path", () => {
    expect(
      parseInterviewerLink("http://localhost:3000/interview/candidate?joinCode=JOIN1234"),
    ).toEqual({ ok: false, reason: "not-interviewer-link" });
  });

  it("rejects unparseable input", () => {
    expect(parseInterviewerLink("not a url at all !!!")).toEqual({
      ok: false,
      reason: "not-interviewer-link",
    });
  });
});

describe("InterviewLobbyPage", () => {
  it("renders the lobby with start and join sections", () => {
    renderLobby("/interview");

    expect(screen.getByRole("heading", { name: "实时面试" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发起面试" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "加入面试" })).toBeInTheDocument();
  });

  it("navigates to the candidate page when starting an interview", () => {
    renderLobby("/interview");

    fireEvent.click(screen.getByRole("button", { name: "发起面试" }));

    expect(screen.getByTestId("candidate-stub")).toBeInTheDocument();
  });

  it("navigates to the interviewer page from a valid pasted link", () => {
    renderLobby("/interview");

    fireEvent.change(screen.getByLabelText("面试官链接"), {
      target: {
        value: "http://localhost:3000/interview/interviewer/room-xyz?joinCode=JOIN1234",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "加入面试" }));

    expect(screen.getByTestId("interviewer-stub")).toHaveTextContent("room-xyz");
  });

  it("navigates to the interviewer page from a basename-prefixed link", () => {
    renderLobby("/interview");

    fireEvent.change(screen.getByLabelText("面试官链接"), {
      target: {
        value: "https://host.example/code-tape/interview/interviewer/room-base?joinCode=JOIN1234",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "加入面试" }));

    expect(screen.getByTestId("interviewer-stub")).toHaveTextContent("room-base");
  });

  it("shows an error and does not navigate for an invalid link", () => {
    renderLobby("/interview");

    fireEvent.change(screen.getByLabelText("面试官链接"), {
      target: { value: "/interview/interviewer/room-1?joinCode=BAD" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加入面试" }));

    expect(screen.queryByTestId("interviewer-stub")).not.toBeInTheDocument();
    expect(screen.getByText("链接无效，请粘贴面试官完整链接（含 joinCode）。")).toBeInTheDocument();
  });
});

function renderLobby(initialEntry: string) {
  const router = createMemoryRouter(
    [
      { path: "/interview", element: <InterviewLobbyPage /> },
      {
        path: "/interview/candidate/:roomId?",
        element: <div data-testid="candidate-stub">candidate</div>,
      },
      {
        path: "/interview/interviewer/:roomId",
        element: <InterviewerStub />,
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

function InterviewerStub() {
  const { roomId } = useParams();
  return <div data-testid="interviewer-stub">{roomId}</div>;
}
