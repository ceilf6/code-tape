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
});

class TestPointerEvent extends MouseEvent {
  pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}
