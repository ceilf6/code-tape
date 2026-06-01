import type { CameraPositionPayload } from "@/shared/recording-schema";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { User } from "lucide-react";

export type CameraPreviewProps = {
  stream: MediaStream | null;
  enabled: boolean;
  position: CameraPositionPayload;
  draggable?: boolean;
  onPositionChange?(position: CameraPositionPayload): void;
  size?: "sm" | "md" | "lg";
};

const DEFAULT_CAMERA_ASPECT_RATIO = 16 / 9;

const SIZE_MAP = {
  sm: { heightClass: "h-24", heightPx: 96 },
  md: { heightClass: "h-32", heightPx: 128 },
  lg: { heightClass: "h-44", heightPx: 176 },
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

function getVideoAspectRatio(video: HTMLVideoElement): number {
  if (video.videoWidth <= 0 || video.videoHeight <= 0) return DEFAULT_CAMERA_ASPECT_RATIO;
  return video.videoWidth / video.videoHeight;
}

/**
 * CameraPreview — floating picture-in-picture of the camera track.
 */
export function CameraPreview(props: CameraPreviewProps) {
  const {
    stream,
    enabled,
    position,
    draggable = false,
    onPositionChange,
    size = "md",
  } = props;

  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });
  const startPerc = useRef({ x: 0, y: 0 });
  const lastEmit = useRef(0);
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_CAMERA_ASPECT_RATIO);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    video.srcObject = stream;
    setAspectRatio(DEFAULT_CAMERA_ASPECT_RATIO);

    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  const getDragPosition = (clientX: number, clientY: number) => {
    const container = containerRef.current;
    const parent = container?.parentElement;
    if (!container || !parent) return null;

    const rect = container.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const maxTravelX = Math.max(0, parentRect.width - rect.width);
    const maxTravelY = Math.max(0, parentRect.height - rect.height);

    const dx = clientX - startPos.current.x;
    const dy = clientY - startPos.current.y;
    const newPxX = clamp(startPerc.current.x * maxTravelX + dx, 0, maxTravelX);
    const newPxY = clamp(startPerc.current.y * maxTravelY + dy, 0, maxTravelY);

    return {
      x: maxTravelX > 0 ? newPxX / maxTravelX : 0,
      y: maxTravelY > 0 ? newPxY / maxTravelY : 0,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!draggable) return;
    dragging.current = true;
    startPos.current = { x: e.clientX, y: e.clientY };
    startPerc.current = { ...position };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const nextPosition = getDragPosition(e.clientX, e.clientY);
    if (!nextPosition) return;

    const now = Date.now();
    if (now - lastEmit.current >= 50) {
      onPositionChange?.(nextPosition);
      lastEmit.current = now;
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const nextPosition = getDragPosition(e.clientX, e.clientY);
    if (nextPosition) {
      onPositionChange?.(nextPosition);
    }
  };

  const sizeConfig = SIZE_MAP[size];

  const style: CSSProperties = {
    left: `${position.x * 100}%`,
    top: `${position.y * 100}%`,
    transform: `translate(-${position.x * 100}%, -${position.y * 100}%)`,
    aspectRatio,
    width: `${Math.round(sizeConfig.heightPx * aspectRatio)}px`,
  };

  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;
    setAspectRatio(getVideoAspectRatio(video));
  };

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={stream ? "Camera preview" : "Camera preview placeholder"}
      style={style}
      className={`absolute z-50 border border-border bg-surface-raised shadow-elevation-2 transition-opacity duration-200 ${sizeConfig.heightClass} ${enabled ? "opacity-100" : "opacity-0 pointer-events-none"} ${draggable ? "cursor-grab active:cursor-grabbing touch-none" : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {stream ? (
        <video
          ref={videoRef}
          className="h-full w-full object-contain"
          autoPlay
          muted
          playsInline
          onLoadedMetadata={handleLoadedMetadata}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted">
          <User className="h-1/2 w-1/2 opacity-50" />
        </div>
      )}
    </div>
  );
}
