import type {
  ActivityDensityBucket,
  ActivityDensityKind,
  ReplayPlaybackRate,
  ReplaySchedulerState,
} from "@/shared/recording-schema";
import { formatDurationMs } from "@/shared/time/duration";
import { IconButton, Slider, Toggle, Toolbar, ToolbarSeparator, cn } from "@/shared/ui";
import { Pause, Play, Volume2, VolumeX, Gauge } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import * as RadixPopover from "@radix-ui/react-popover";
import * as RadixSlider from "@radix-ui/react-slider";

export type ReplayControlsProps = {
  state: ReplaySchedulerState;
  durationMs: number;
  onPlayPause(): void;
  onSeek(targetMs: number): Promise<void> | void;
  onRate(rate: ReplayPlaybackRate): void;
  volume: number;
  muted: boolean;
  onVolume(volume: number): void;
  onMuted(muted: boolean): void;
  activityDensity?: ActivityDensityBucket[];
};

const PLAYBACK_RATES: ReplayPlaybackRate[] = [2, 1.5, 1, 0.5];

export function ReplayControls({
  state,
  durationMs,
  onPlayPause,
  onSeek,
  onRate,
  volume,
  muted,
  onVolume,
  onMuted,
  activityDensity = [],
}: ReplayControlsProps) {
  const [ratePopoverOpen, setRatePopoverOpen] = useState(false);
  const [volumePopoverOpen, setVolumePopoverOpen] = useState(false);
  const [pendingProgressPercent, setPendingProgressPercent] = useState<number | null>(null);
  const rateCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volumeCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isPlaying = state.status === "playing" || state.status === "buffering";
  const safeDuration = Math.max(0, durationMs);
  const baseCurrentTime = Math.min(Math.max(0, state.timelineTimeMs), safeDuration);
  const baseProgressPercent = safeDuration > 0 ? (baseCurrentTime / safeDuration) * 100 : 0;
  const currentProgressPercent = pendingProgressPercent ?? baseProgressPercent;
  const currentTime = (currentProgressPercent / 100) * safeDuration;
  const displayedVolume = muted ? 0 : volume;
  const timelineDisabled =
    safeDuration === 0 ||
    state.status === "loading" ||
    state.status === "seeking" ||
    state.status === "error";

  useEffect(() => {
    return () => {
      if (rateCloseTimeoutRef.current) clearTimeout(rateCloseTimeoutRef.current);
      if (volumeCloseTimeoutRef.current) clearTimeout(volumeCloseTimeoutRef.current);
    };
  }, []);

  const openRatePopover = () => {
    if (rateCloseTimeoutRef.current) clearTimeout(rateCloseTimeoutRef.current);
    rateCloseTimeoutRef.current = setTimeout(() => {
      setRatePopoverOpen(true);
    }, 200);
  };

  const closeRatePopover = () => {
    if (rateCloseTimeoutRef.current) clearTimeout(rateCloseTimeoutRef.current);
    rateCloseTimeoutRef.current = setTimeout(() => {
      setRatePopoverOpen(false);
    }, 200);
  };

  const openVolumePopover = () => {
    if (volumeCloseTimeoutRef.current) clearTimeout(volumeCloseTimeoutRef.current);
    volumeCloseTimeoutRef.current = setTimeout(() => {
      setVolumePopoverOpen(true);
    }, 200);
  };

  const closeVolumePopover = () => {
    if (volumeCloseTimeoutRef.current) clearTimeout(volumeCloseTimeoutRef.current);
    volumeCloseTimeoutRef.current = setTimeout(() => {
      setVolumePopoverOpen(false);
    }, 200);
  };

  const handleSliderChange = (value: number) => {
    if (timelineDisabled) return;
    setPendingProgressPercent(value);
  };

  const handleSliderCommit = async (value: number) => {
    if (timelineDisabled) return;
    const targetMs = (value / 100) * safeDuration;
    setPendingProgressPercent(null);
    await onSeek(targetMs);
  };

  const handleVolumeChange = (v: number) => {
    if (muted && v > 0) {
      onMuted(false);
    }
    if (!muted && v === 0) {
      onMuted(true);
    }
    onVolume(v);
  };

  return (
    <Toolbar className="h-auto min-h-14 flex-wrap gap-3 px-4 py-2">
      <IconButton
        label={isPlaying ? "暂停" : "播放"}
        icon={isPlaying ? <Pause size={18} /> : <Play size={18} />}
        variant="solid"
        disabled={
          state.status === "loading" || state.status === "seeking" || state.status === "error"
        }
        onClick={onPlayPause}
      />

      <div className="min-w-[3.5rem] text-right">
        <span className="font-mono text-sm tabular-nums text-foreground">
          {formatDurationMs(currentTime)}
        </span>
      </div>

      <div className="relative flex-1 min-w-[120px]" data-replay-progress-control>
        <ReplayActivityMarkers activityDensity={activityDensity} durationMs={safeDuration} />
        <Slider
          value={currentProgressPercent}
          min={0}
          max={100}
          step={0.1}
          disabled={timelineDisabled}
          ariaLabel="播放进度"
          onChange={handleSliderChange}
          onCommit={handleSliderCommit}
        />
      </div>

      <div className="min-w-[3.5rem]">
        <span className="font-mono text-sm tabular-nums text-muted">
          {formatDurationMs(safeDuration)}
        </span>
      </div>

      <ToolbarSeparator />

      <div onMouseEnter={openRatePopover} onMouseLeave={closeRatePopover}>
        <RadixPopover.Root open={ratePopoverOpen} onOpenChange={setRatePopoverOpen}>
          <RadixPopover.Trigger asChild>
            <IconButton label="倍速" icon={<Gauge size={18} />} variant="ghost" />
          </RadixPopover.Trigger>
          <RadixPopover.Portal>
            <RadixPopover.Content
              align="center"
              side="top"
              sideOffset={10}
              onMouseEnter={() => {
                if (rateCloseTimeoutRef.current) clearTimeout(rateCloseTimeoutRef.current);
              }}
              onMouseLeave={closeRatePopover}
              className={cn(
                "z-50 w-16 rounded-sm border border-border bg-surface p-1 text-foreground shadow-elevation-2",
                "outline-none data-[state=delayed-open]:animate-fade-in",
              )}
            >
              <div className="flex flex-col gap-0.5" role="listbox">
                {PLAYBACK_RATES.map((rate) => (
                  <button
                    key={rate}
                    type="button"
                    role="option"
                    aria-selected={state.playbackRate === rate}
                    className={cn(
                      "w-full rounded px-2 py-1.5 text-sm font-mono tabular-nums transition-colors text-center font-normal",
                      state.playbackRate === rate
                        ? "bg-primary/10 text-primary"
                        : "text-foreground hover:bg-surface-raised",
                    )}
                    onClick={() => onRate(rate)}
                  >
                    {rate}x
                  </button>
                ))}
              </div>
            </RadixPopover.Content>
          </RadixPopover.Portal>
        </RadixPopover.Root>
      </div>

      <div data-replay-volume-control onMouseEnter={openVolumePopover} onMouseLeave={closeVolumePopover}>
        <RadixPopover.Root open={volumePopoverOpen} onOpenChange={setVolumePopoverOpen}>
          <RadixPopover.Trigger asChild>
            <Toggle
              pressed={muted}
              onPressedChange={(pressed) => onMuted(pressed)}
              label={muted ? "取消静音" : "静音"}
              icon={<Volume2 size={18} />}
              iconPressed={<VolumeX size={18} />}
            />
          </RadixPopover.Trigger>
          <RadixPopover.Portal>
            <RadixPopover.Content
              align="center"
              side="top"
              sideOffset={10}
              onMouseEnter={() => {
                if (volumeCloseTimeoutRef.current) clearTimeout(volumeCloseTimeoutRef.current);
              }}
              onMouseLeave={closeVolumePopover}
              className={cn(
                "z-50 w-12 rounded-sm border border-border bg-surface p-2 text-foreground shadow-elevation-2",
                "outline-none data-[state=delayed-open]:animate-fade-in",
              )}
            >
              <div className="flex flex-col gap-2 items-center">
                <span className="text-sm font-mono tabular-nums">{displayedVolume}</span>
                <RadixSlider.Root
                  className="relative flex h-24 w-full select-none items-center flex-col"
                  value={[displayedVolume]}
                  min={0}
                  max={100}
                  step={1}
                  onValueChange={(values) => handleVolumeChange(values[0] ?? 0)}
                  aria-label="音量"
                  orientation="vertical"
                >
                  <RadixSlider.Track className="relative w-1 h-full grow rounded-full bg-border">
                    <RadixSlider.Range className="absolute w-full rounded-full bg-primary" />
                  </RadixSlider.Track>
                  <RadixSlider.Thumb
                    aria-label="音量"
                    className="block h-3 w-3 rounded-full bg-foreground shadow-elevation-2 transition-transform duration-150 ease-out-soft hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  />
                </RadixSlider.Root>
              </div>
            </RadixPopover.Content>
          </RadixPopover.Portal>
        </RadixPopover.Root>
      </div>
    </Toolbar>
  );
}

function ReplayActivityMarkers({
  activityDensity,
  durationMs,
}: {
  activityDensity: ActivityDensityBucket[];
  durationMs: number;
}) {
  if (durationMs <= 0 || activityDensity.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-x-2 top-1/2 z-10 h-2 -translate-y-1/2">
      {activityDensity.map((bucket, index) => {
        const left = clampPercent((bucket.startMs / durationMs) * 100);
        const width = Math.max(
          0.8,
          clampPercent(((bucket.endMs - bucket.startMs) / durationMs) * 100),
        );
        return (
          <span
            key={`${bucket.kind}-${bucket.startMs}-${bucket.endMs}-${index}`}
            aria-label={`活动：${activityKindLabel(bucket.kind)} ${formatDurationMs(bucket.startMs)}-${formatDurationMs(bucket.endMs)}`}
            className={cn(
              "absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full border border-background/80",
              activityKindClassName(bucket.kind),
            )}
            style={{ left: `${left}%`, width: `${width}%` }}
          />
        );
      })}
    </div>
  );
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function activityKindLabel(kind: ActivityDensityKind): string {
  switch (kind) {
    case "edit":
      return "编辑";
    case "run":
      return "运行";
    case "error":
      return "错误";
    case "shortcut":
      return "快捷键";
    case "silence":
      return "静默";
  }
}

function activityKindClassName(kind: ActivityDensityKind): string {
  switch (kind) {
    case "error":
      return "bg-danger shadow-[0_0_10px_var(--ct-color-danger)]";
    case "run":
      return "bg-primary";
    case "shortcut":
      return "bg-warning";
    case "edit":
      return "bg-foreground/70";
    case "silence":
      return "bg-border";
  }
}
