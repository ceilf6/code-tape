import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReplayStableState } from "@/shared/recording-schema";
import { RuntimeOutputPanel } from "../RuntimeOutputPanel";

function makeRuntime(
  patch: Partial<ReplayStableState["runtime"]> = {},
): ReplayStableState["runtime"] {
  return {
    status: "idle",
    stdout: [],
    stderr: [],
    previewHtml: null,
    errorMessage: null,
    ...patch,
  };
}

describe("RuntimeOutputPanel", () => {
  it("renders the status badge and a No output placeholder when empty", () => {
    render(<RuntimeOutputPanel runtime={makeRuntime({ status: "idle" })} />);

    expect(screen.getByText("Console")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.getByText("No output")).toBeInTheDocument();
  });

  it("renders stdout, stderr, and error lines", () => {
    render(
      <RuntimeOutputPanel
        runtime={makeRuntime({
          status: "error",
          stdout: ["out line"],
          stderr: ["warn line"],
          errorMessage: "boom",
        })}
      />,
    );

    expect(screen.getByText("out line")).toBeInTheDocument();
    expect(screen.getByText("warn line")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.queryByText("No output")).not.toBeInTheDocument();
  });
});
