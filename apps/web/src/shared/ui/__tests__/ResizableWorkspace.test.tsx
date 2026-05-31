import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizableWorkspace } from "../ResizableWorkspace";

describe("ResizableWorkspace", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("PointerEvent", TestPointerEvent);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates and persists the split when the separator is dragged", () => {
    render(
      <ResizableWorkspace
        ariaLabel="测试工作区"
        separatorLabel="调整测试工作区宽度"
        storageKey="code-tape:test-workspace:left-percent"
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );
    const workspace = screen.getByLabelText("测试工作区");
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 1000,
      bottom: 600,
      width: 1000,
      height: 600,
      toJSON: () => ({}),
    });

    const separator = screen.getByRole("separator", { name: "调整测试工作区宽度" });
    fireEvent(separator, new PointerEvent("pointerdown", { bubbles: true, clientX: 680, pointerId: 1 }));
    fireEvent(separator, new PointerEvent("pointermove", { bubbles: true, clientX: 760, pointerId: 1 }));
    fireEvent(separator, new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));

    expect(separator).toHaveAttribute("aria-valuenow", "76");
    expect(window.localStorage.getItem("code-tape:test-workspace:left-percent")).toBe("76");
  });

  it("keeps the separator desktop-only while the base layout stays stacked", () => {
    render(
      <ResizableWorkspace
        ariaLabel="窄屏测试工作区"
        separatorLabel="调整窄屏测试工作区宽度"
        storageKey="code-tape:narrow-workspace:left-percent"
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );

    expect(screen.getByLabelText("窄屏测试工作区")).toHaveClass("flex-col", "md:flex-row");
    expect(screen.getByRole("separator", { name: "调整窄屏测试工作区宽度" })).toHaveClass(
      "hidden",
      "md:flex",
    );
  });

  it("falls back from invalid persisted values and clamps out-of-range values", () => {
    window.localStorage.setItem("code-tape:invalid-workspace:left-percent", "not-a-number");
    const { unmount } = render(
      <ResizableWorkspace
        ariaLabel="损坏偏好工作区"
        separatorLabel="调整损坏偏好工作区宽度"
        storageKey="code-tape:invalid-workspace:left-percent"
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );
    expect(screen.getByRole("separator", { name: "调整损坏偏好工作区宽度" })).toHaveAttribute(
      "aria-valuenow",
      "68",
    );
    unmount();

    window.localStorage.setItem("code-tape:clamped-workspace:left-percent", "99");
    render(
      <ResizableWorkspace
        ariaLabel="越界偏好工作区"
        separatorLabel="调整越界偏好工作区宽度"
        storageKey="code-tape:clamped-workspace:left-percent"
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );
    expect(screen.getByRole("separator", { name: "调整越界偏好工作区宽度" })).toHaveAttribute(
      "aria-valuenow",
      "78",
    );
  });
});

class TestPointerEvent extends MouseEvent {
  pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
