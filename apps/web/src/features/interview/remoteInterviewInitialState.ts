import type { ReplayStableState } from "@/shared/recording-schema";

export const INITIAL_REMOTE_INTERVIEW_STABLE_STATE: ReplayStableState = {
  editor: {
    code: "",
    language: "typescript",
    cursor: null,
    selection: null,
    scrollTop: 0,
    scrollLeft: 0,
    fontSize: 14,
    theme: "dark",
  },
  pointer: null,
  media: {
    microphoneEnabled: false,
    cameraEnabled: false,
    cameraPosition: { x: 0, y: 0 },
  },
  runtime: {
    status: "idle",
    stdout: [],
    stderr: [],
    previewHtml: null,
    errorMessage: null,
  },
};
