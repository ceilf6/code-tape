import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewPane } from "../PreviewPane";
import type { IframeRuntime } from "@/shared/recording-schema";

function makeRuntime(): IframeRuntime {
  return {
    mount: vi.fn(async () => {}),
    run: vi.fn(),
    renderPreview: vi.fn(async () => {}),
    renderDocument: vi.fn(async (html: string) => html),
    setTheme: vi.fn(),
    reset: vi.fn(),
    destroy: vi.fn(),
  } as unknown as IframeRuntime;
}

describe("PreviewPane", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows a reset preview action that calls IframeRuntime.reset", async () => {
    const runtime = makeRuntime();

    render(<PreviewPane runtime={runtime} />);
    await waitFor(() => expect(runtime.mount).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "重置预览" }));

    expect(runtime.reset).toHaveBeenCalledTimes(1);
  });

  it("hides the reset action when showReset is false", async () => {
    const runtime = makeRuntime();

    render(<PreviewPane runtime={runtime} showReset={false} />);
    await waitFor(() => expect(runtime.mount).toHaveBeenCalled());

    expect(screen.queryByRole("button", { name: "重置预览" })).not.toBeInTheDocument();
  });

  it("propagates the theme prop to the runtime via setTheme", async () => {
    const runtime = makeRuntime();
    const { rerender } = render(<PreviewPane runtime={runtime} theme="dark" />);
    await waitFor(() => expect(runtime.mount).toHaveBeenCalled());
    expect(runtime.setTheme).toHaveBeenCalledWith("dark");

    rerender(<PreviewPane runtime={runtime} theme="light" />);
    expect(runtime.setTheme).toHaveBeenCalledWith("light");
  });
});
