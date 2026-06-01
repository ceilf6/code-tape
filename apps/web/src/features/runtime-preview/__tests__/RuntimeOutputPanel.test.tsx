import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("RuntimeOutputPanel", () => {
  it("renders the status badge and a No output placeholder when empty", () => {
    render(<RuntimeOutputPanel runtime={makeRuntime({ status: "idle" })} />);

    expect(screen.getByText("Console")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.getByText("暂无运行输出")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制运行输出" })).toBeDisabled();
  });

  it("renders categorized output counts and filters lines by channel", () => {
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

    expect(screen.getByRole("button", { name: "全部 3" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "stdout 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "stderr 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "error 1" })).toBeInTheDocument();
    expect(screen.getByText("out line")).toBeInTheDocument();
    expect(screen.getByText("warn line")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
    expect(screen.getAllByText("error").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("暂无运行输出")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "stderr 1" }));

    expect(screen.queryByText("out line")).not.toBeInTheDocument();
    expect(screen.getByText("warn line")).toBeInTheDocument();
    expect(screen.queryByText("boom")).not.toBeInTheDocument();
  });

  it("shows an explicit empty state when the selected channel has no output", () => {
    render(<RuntimeOutputPanel runtime={makeRuntime({ status: "success", stdout: ["done"] })} />);

    fireEvent.click(screen.getByRole("button", { name: "stderr 0" }));

    expect(screen.getByText("stderr 暂无输出")).toBeInTheDocument();
    expect(screen.queryByText("done")).not.toBeInTheDocument();
  });

  it("copies the complete output with channel labels", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
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

    fireEvent.click(screen.getByRole("button", { name: "复制运行输出" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("[stdout] out line\n[stderr] warn line\n[error] boom"),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("输出已复制");
  });

  it("reports copy failures", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(<RuntimeOutputPanel runtime={makeRuntime({ status: "success", stdout: ["done"] })} />);

    fireEvent.click(screen.getByRole("button", { name: "复制运行输出" }));

    expect(await screen.findByRole("status")).toHaveTextContent("复制失败");
  });
});
