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

  it("can delay the horizontal split until the large breakpoint", () => {
    render(
      <ResizableWorkspace
        ariaLabel="大屏测试工作区"
        separatorLabel="调整大屏测试工作区宽度"
        storageKey="code-tape:large-workspace:left-percent"
        desktopBreakpoint="lg"
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );

    expect(screen.getByLabelText("大屏测试工作区")).toHaveClass("flex-col", "lg:flex-row");
    expect(screen.getByRole("separator", { name: "调整大屏测试工作区宽度" })).toHaveClass(
      "hidden",
      "lg:flex",
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

  it("preserves the legacy horizontal ArrowDown/ArrowUp keyboard behavior", () => {
    render(
      <ResizableWorkspace
        ariaLabel="水平键盘工作区"
        separatorLabel="调整水平键盘工作区宽度"
        storageKey="code-tape:horizontal-keyboard:left-percent"
        defaultLeftPercent={68}
        minLeftPercent={52}
        maxLeftPercent={78}
        step={4}
        left={<div>Left</div>}
        right={<div>Right</div>}
      />,
    );
    const separator = screen.getByRole("separator", { name: "调整水平键盘工作区宽度" });
    // 旧行为：ArrowDown 缩小左栏，ArrowUp 增大左栏。
    fireEvent.keyDown(separator, { key: "ArrowDown" });
    expect(separator).toHaveAttribute("aria-valuenow", "64");
    fireEvent.keyDown(separator, { key: "ArrowUp" });
    fireEvent.keyDown(separator, { key: "ArrowUp" });
    expect(separator).toHaveAttribute("aria-valuenow", "72");
  });

  it("updates and persists the split when dragged vertically", () => {
    render(
      <ResizableWorkspace
        orientation="vertical"
        ariaLabel="竖直工作区"
        separatorLabel="调整竖直工作区高度"
        storageKey="code-tape:vertical-workspace:left-percent"
        defaultLeftPercent={68}
        minLeftPercent={30}
        maxLeftPercent={85}
        left={<div>Top</div>}
        right={<div>Bottom</div>}
      />,
    );
    const workspace = screen.getByLabelText("竖直工作区");
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 500,
      width: 800,
      height: 500,
      toJSON: () => ({}),
    });

    const separator = screen.getByRole("separator", { name: "调整竖直工作区高度" });
    expect(separator).toHaveAttribute("aria-orientation", "horizontal");
    // 竖直方向用 clientY 计算：250/500 = 50%（落在 [30,85] 内，step=4 → 48 or 52）。
    fireEvent(separator, new PointerEvent("pointerdown", { bubbles: true, clientY: 250, pointerId: 1 }));
    fireEvent(separator, new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));

    const valueNow = Number(separator.getAttribute("aria-valuenow"));
    expect(valueNow).toBeGreaterThanOrEqual(30);
    expect(valueNow).toBeLessThanOrEqual(85);
    expect(valueNow % 4).toBe(0);
    expect(window.localStorage.getItem("code-tape:vertical-workspace:left-percent")).toBe(
      String(valueNow),
    );
  });

  it("keeps the vertical separator visible on all viewports (not desktop-only)", () => {
    render(
      <ResizableWorkspace
        orientation="vertical"
        ariaLabel="竖直可见工作区"
        separatorLabel="调整竖直可见工作区高度"
        storageKey="code-tape:vertical-visible:left-percent"
        left={<div>Top</div>}
        right={<div>Bottom</div>}
      />,
    );
    const separator = screen.getByRole("separator", { name: "调整竖直可见工作区高度" });
    expect(separator).toHaveClass("flex", "cursor-row-resize");
    expect(separator).not.toHaveClass("hidden");
  });

  it("adjusts the vertical split with ArrowUp/ArrowDown keys", () => {
    render(
      <ResizableWorkspace
        orientation="vertical"
        ariaLabel="竖直键盘工作区"
        separatorLabel="调整竖直键盘工作区高度"
        storageKey="code-tape:vertical-keyboard:left-percent"
        defaultLeftPercent={60}
        minLeftPercent={30}
        maxLeftPercent={85}
        step={4}
        left={<div>Top</div>}
        right={<div>Bottom</div>}
      />,
    );
    const separator = screen.getByRole("separator", { name: "调整竖直键盘工作区高度" });
    fireEvent.keyDown(separator, { key: "ArrowDown" });
    expect(separator).toHaveAttribute("aria-valuenow", "64");
    fireEvent.keyDown(separator, { key: "ArrowUp" });
    fireEvent.keyDown(separator, { key: "ArrowUp" });
    expect(separator).toHaveAttribute("aria-valuenow", "56");
  });
});

class TestPointerEvent extends MouseEvent {
  pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
