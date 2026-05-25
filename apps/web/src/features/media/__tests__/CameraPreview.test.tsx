/**
 * @vitest-environment jsdom
 */
import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CameraPreview } from "../CameraPreview";

describe("CameraPreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("renders placeholder when stream is null", () => {
    const { container } = render(
      <CameraPreview
        stream={null}
        enabled={true}
        position={{ x: 0, y: 0 }}
      />
    );
    expect(screen.getByRole("img", { name: "Camera preview placeholder" })).toBeInTheDocument();
    expect(container.querySelector("video")).not.toBeInTheDocument();
  });

  it("renders video and binds stream when stream is present", () => {
    // Mock MediaStream
    const MockMediaStream = class {} as typeof MediaStream;
    global.MediaStream = MockMediaStream;
    const mockStream = new MockMediaStream();
    
    // We need to spy on HTMLVideoElement.prototype.srcObject
    const setSrcObject = vi.fn();
    Object.defineProperty(HTMLVideoElement.prototype, "srcObject", {
      set: setSrcObject,
      configurable: true,
    });

    render(
      <CameraPreview
        stream={mockStream}
        enabled={true}
        position={{ x: 0, y: 0 }}
      />
    );

    const video = screen.getByRole("img", { name: "Camera preview" }).querySelector("video");
    expect(video).toBeInTheDocument();
    expect(setSrcObject).toHaveBeenCalledWith(mockStream);
  });

  it("applies hidden classes when disabled", () => {
    render(
      <CameraPreview
        stream={null}
        enabled={false}
        position={{ x: 0.5, y: 0.5 }}
      />
    );
    
    const preview = screen.getByRole("img", { name: "Camera preview placeholder" });
    expect(preview.className).toContain("opacity-0");
    expect(preview.className).toContain("pointer-events-none");
    
    // Position should still be retained
    expect(preview.style.left).toBe("50%");
    expect(preview.style.top).toBe("50%");
  });

  it("supports dragging and fires onPositionChange throttled", () => {
    const handleChange = vi.fn();
    
    render(
      <div style={{ width: 1000, height: 1000 }}>
        <CameraPreview
          stream={null}
          enabled={true}
          position={{ x: 0.5, y: 0.5 }}
          draggable={true}
          onPositionChange={handleChange}
        />
      </div>
    );

    const preview = screen.getByRole("img", { name: "Camera preview placeholder" });

    // Mock getBoundingClientRect for parent and element
    vi.spyOn(preview, "getBoundingClientRect").mockReturnValue({
      width: 100,
      height: 100,
      top: 0, left: 0, bottom: 100, right: 100,
      x: 0, y: 0,
      toJSON: () => {}
    });

    vi.spyOn(preview.parentElement!, "getBoundingClientRect").mockReturnValue({
      width: 1000,
      height: 1000,
      top: 0, left: 0, bottom: 1000, right: 1000,
      x: 0, y: 0,
      toJSON: () => {}
    });

    // Start drag
    fireEvent.pointerDown(preview, { clientX: 500, clientY: 500, pointerId: 1 });
    
    // Move
    fireEvent.pointerMove(preview, { clientX: 550, clientY: 550, pointerId: 1 });
    
    // Because of 50ms throttle from start, first move might trigger if it's the first
    act(() => {
      vi.advanceTimersByTime(60);
    });

    fireEvent.pointerMove(preview, { clientX: 600, clientY: 600, pointerId: 1 });

    // Stop drag
    fireEvent.pointerUp(preview, { clientX: 600, clientY: 600, pointerId: 1 });

    expect(handleChange).toHaveBeenCalled();
  });
});
