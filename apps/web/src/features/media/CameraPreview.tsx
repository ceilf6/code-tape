import type { CameraPositionPayload } from "@/shared/recording-schema";
import { useEffect, useRef } from "react";
import { User } from "lucide-react";

export type CameraPreviewProps = {
  stream: MediaStream | null;
  enabled: boolean;
  position: CameraPositionPayload;
  draggable?: boolean;
  onPositionChange?(position: CameraPositionPayload): void;
  size?: "sm" | "md" | "lg";
};

const SIZE_MAP = {
  sm: "h-24 w-24", // 96px
  md: "h-32 w-32", // 128px
  lg: "h-44 w-44", // 176px
};

/**
 * CameraPreview — round picture-in-picture of the camera track.
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
  
  // Drag state
  const dragging = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });
  const startPerc = useRef({ x: 0, y: 0 });
  const lastEmit = useRef(0);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    } else if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, [stream]);

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
    
    const container = containerRef.current;
    const parent = container?.parentElement;
    if (!container || !parent) return;

    const dx = e.clientX - startPos.current.x;
    const dy = e.clientY - startPos.current.y;

    const rect = container.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();

    const maxTravelX = parentRect.width - rect.width;
    const maxTravelY = parentRect.height - rect.height;

    const startPxX = startPerc.current.x * maxTravelX;
    const startPxY = startPerc.current.y * maxTravelY;

    let newPxX = startPxX + dx;
    let newPxY = startPxY + dy;

    newPxX = Math.max(0, Math.min(newPxX, maxTravelX));
    newPxY = Math.max(0, Math.min(newPxY, maxTravelY));

    const newPercX = maxTravelX > 0 ? newPxX / maxTravelX : 0;
    const newPercY = maxTravelY > 0 ? newPxY / maxTravelY : 0;

    const now = Date.now();
    if (now - lastEmit.current >= 50) {
      onPositionChange?.({ x: newPercX, y: newPercY });
      lastEmit.current = now;
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    
    const container = containerRef.current;
    const parent = container?.parentElement;
    if (!container || !parent) return;

    const dx = e.clientX - startPos.current.x;
    const dy = e.clientY - startPos.current.y;

    const rect = container.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();

    const maxTravelX = parentRect.width - rect.width;
    const maxTravelY = parentRect.height - rect.height;

    const startPxX = startPerc.current.x * maxTravelX;
    const startPxY = startPerc.current.y * maxTravelY;

    let newPxX = startPxX + dx;
    let newPxY = startPxY + dy;

    newPxX = Math.max(0, Math.min(newPxX, maxTravelX));
    newPxY = Math.max(0, Math.min(newPxY, maxTravelY));

    const newPercX = maxTravelX > 0 ? newPxX / maxTravelX : 0;
    const newPercY = maxTravelY > 0 ? newPxY / maxTravelY : 0;

    onPositionChange?.({ x: newPercX, y: newPercY });
  };

  const sizeClass = SIZE_MAP[size];

  const style = {
    left: `${position.x * 100}%`,
    top: `${position.y * 100}%`,
    transform: `translate(-${position.x * 100}%, -${position.y * 100}%)`
  };

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={stream ? "Camera preview" : "Camera preview placeholder"}
      style={style}
      className={`absolute z-50 overflow-hidden rounded-full border border-border bg-surface-raised shadow-elevation-2 transition-opacity duration-200 ${sizeClass} ${enabled ? "opacity-100" : "opacity-0 pointer-events-none"} ${draggable ? "cursor-grab active:cursor-grabbing touch-none" : ""}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {stream ? (
        <video
          ref={videoRef}
          className="h-full w-full object-cover"
          autoPlay
          muted
          playsInline
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted">
          <User className="h-1/2 w-1/2 opacity-50" />
        </div>
      )}
    </div>
  );
}
