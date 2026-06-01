import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.useRealTimers();
});

describe("RuntimeOutputPanel", () => {
  it("renders the status badge and the empty-state placeholder when there is no output", () => {
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
    expect(screen.getByRole("button", { name: "stdout 1" })).not.toHaveAttribute("aria-label");
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

  it("clears copy success feedback after a short confirmation window", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<RuntimeOutputPanel runtime={makeRuntime({ status: "success", stdout: ["done"] })} />);

    fireEvent.click(screen.getByRole("button", { name: "复制运行输出" }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("status")).toHaveTextContent("输出已复制");

    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports copy failures as alerts", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    render(<RuntimeOutputPanel runtime={makeRuntime({ status: "success", stdout: ["done"] })} />);

    fireEvent.click(screen.getByRole("button", { name: "复制运行输出" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("复制失败");
    expect(alert).toHaveClass("text-danger");
  });
});
