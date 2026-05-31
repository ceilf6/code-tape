export type VideoThumbnailOptions = {
  width: number;
  height: number;
  mimeType: string;
  quality: number;
  seekBackMs: number;
  timeoutMs: number;
};

export const DEFAULT_VIDEO_THUMBNAIL_OPTIONS: VideoThumbnailOptions = {
  width: 320,
  height: 180,
  mimeType: "image/webp",
  quality: 0.82,
  seekBackMs: 100,
  timeoutMs: 2_500,
};

export async function createVideoThumbnail(
  mediaBlob: Blob,
  options: VideoThumbnailOptions = DEFAULT_VIDEO_THUMBNAIL_OPTIONS,
): Promise<Blob | null> {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return null;

  const video = document.createElement("video");
  const objectUrl = URL.createObjectURL(mediaBlob);
  try {
    video.muted = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.src = objectUrl;

    await waitForMediaEvent(video, "loadedmetadata", options.timeoutMs);
    if (Number.isFinite(video.duration) && video.duration > 0) {
      const targetTimeSec = Math.max(0, video.duration - options.seekBackMs / 1000);
      if (targetTimeSec > 0) {
        video.currentTime = targetTimeSec;
        await waitForMediaEvent(video, "seeked", options.timeoutMs);
      } else {
        await waitForMediaEvent(video, "loadeddata", options.timeoutMs);
      }
    } else {
      await waitForMediaEvent(video, "loadeddata", options.timeoutMs);
    }

    const canvas = document.createElement("canvas");
    canvas.width = options.width;
    canvas.height = options.height;
    const context = canvas.getContext("2d");
    if (!context) return null;

    context.fillStyle = "#05070a";
    context.fillRect(0, 0, canvas.width, canvas.height);
    drawContainedFrame(context, video, canvas.width, canvas.height);

    return await canvasToBlob(canvas, options.mimeType, options.quality);
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

function waitForMediaEvent(
  video: HTMLVideoElement,
  eventName: "loadedmetadata" | "loadeddata" | "seeked",
  timeoutMs: number,
) {
  if (eventName === "loadedmetadata" && video.readyState >= 1) return Promise.resolve();
  if (eventName === "loadeddata" && video.readyState >= 2) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`video ${eventName} timed out`));
    }, timeoutMs);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener(eventName, handleEvent);
      video.removeEventListener("error", handleError);
    };
    const handleEvent = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(video.error ?? new Error(`video ${eventName} failed`));
    };
    video.addEventListener(eventName, handleEvent, { once: true });
    video.addEventListener("error", handleError, { once: true });
  });
}

function drawContainedFrame(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  width: number,
  height: number,
) {
  const sourceWidth = video.videoWidth || width;
  const sourceHeight = video.videoHeight || height;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = Math.round(sourceWidth * scale);
  const drawHeight = Math.round(sourceHeight * scale);
  const dx = Math.round((width - drawWidth) / 2);
  const dy = Math.round((height - drawHeight) / 2);
  context.drawImage(video, dx, dy, drawWidth, drawHeight);
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number) {
  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}
