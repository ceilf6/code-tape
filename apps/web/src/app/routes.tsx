import { createBrowserRouter, type RouteObject } from "react-router-dom";
import { AppShell } from "./AppShell";
import { RecordingLibraryPage } from "@/features/library/RecordingLibraryPage";
import { RecorderPage } from "@/features/recorder/RecorderPage";
import { ReplayPage } from "@/features/player/ReplayPage";
import { CandidateInterviewPage } from "@/features/interview/CandidateInterviewPage";
import { InterviewLobbyPage } from "@/features/interview/InterviewLobbyPage";
import { RemoteInterviewWorkbenchPage } from "@/features/interview/RemoteInterviewWorkbenchPage";
import { NotFoundPage } from "./NotFoundPage";
import { routerBasename } from "./routerBase";

export const appRoutes: RouteObject[] = [
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <RecordingLibraryPage /> },
      { path: "record", element: <RecorderPage /> },
      { path: "replay/:id", element: <ReplayPage /> },
      { path: "interview/candidate/:roomId?", element: <CandidateInterviewPage /> },
      { path: "replays/:id", element: <ReplayPage source="cloud" /> },
      { path: "cloud/replay/:id", element: <ReplayPage source="cloud" /> },
      { path: "s/:token", element: <ReplayPage source="share" /> },
      { path: "interview", element: <InterviewLobbyPage /> },
      { path: "interview/interviewer/:roomId", element: <RemoteInterviewWorkbenchPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(appRoutes, { basename: routerBasename });
