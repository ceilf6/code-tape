import { afterEach, describe, expect, it, vi } from "vitest";
import { createVideoThumbnail, DEFAULT_VIDEO_THUMBNAIL_OPTIONS } from "../videoThumbnail";

describe("createVideoThumbnail", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("times out when video metadata never settles", async () => {
    vi.useFakeTimers();
    const video = {
      readyState: 0,
      error: null,
      muted: false,
      preload: "",
      playsInline: false,
      src: "",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    };
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName, options) => {
      if (tagName === "video") return video as unknown as HTMLVideoElement;
      return originalCreateElement(tagName, options);
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:thumbnail-source"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    const thumbnail = createVideoThumbnail(new Blob(["bad"], { type: "video/webm" }), {
      ...DEFAULT_VIDEO_THUMBNAIL_OPTIONS,
      timeoutMs: 5,
    });
    const timeoutExpectation = expect(thumbnail).rejects.toThrow("video loadedmetadata timed out");
    await vi.advanceTimersByTimeAsync(5);

    await timeoutExpectation;
    expect(video.removeEventListener).toHaveBeenCalledWith("loadedmetadata", expect.any(Function));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:thumbnail-source");
  });
});
