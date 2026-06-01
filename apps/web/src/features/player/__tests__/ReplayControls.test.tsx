import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReplaySchedulerState } from "@/shared/recording-schema";
import { ReplayControls, type ReplayControlsProps } from "../ReplayControls";

type SliderRootProps = {
  value?: number[];
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  "aria-label"?: string;
  onValueChange?: (values: number[]) => void;
  onValueCommit?: (values: number[]) => void;
};

vi.mock("@radix-ui/react-slider", () => ({
  Root({
    value = [0],
    min = 0,
    max = 100,
    step = 1,
    disabled,
    "aria-label": ariaLabel,
    onValueChange,
    onValueCommit,
  }: SliderRootProps) {
    const currentValue = value[0] ?? min;
    return (
      <input
        aria-label={ariaLabel}
        type="range"
        value={currentValue}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onValueChange?.([Number(event.currentTarget.value)])}
        onMouseUp={(event) => onValueCommit?.([Number(event.currentTarget.value)])}
      />
    );
  },
  Track() {
    return null;
  },
  Range() {
    return null;
  },
  Thumb() {
    return null;
  },
}));

function state(
  status: ReplaySchedulerState["status"],
  patch: Partial<ReplaySchedulerState> = {},
): ReplaySchedulerState {
  return {
    status,
    timelineTimeMs: 0,
    playbackRate: 1,
    lastAppliedSeq: 0,
    mediaStatus: "none",
    driftMs: 0,
    ...patch,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

function renderControls(overrides: Partial<ReplayControlsProps> = {}) {
  const props: ReplayControlsProps = {
    state: state("ready"),
    durationMs: 120_000,
    onPlayPause: vi.fn(),
    onSeek: vi.fn(),
    onRate: vi.fn(),
    volume: 80,
    muted: false,
    onVolume: vi.fn(),
    onMuted: vi.fn(),
    ...overrides,
  };
  return {
    props,
    ...render(<ReplayControls {...props} />),
  };
}

function openHoverPopover(buttonName: string | RegExp) {
  const trigger = screen.getByRole("button", { name: buttonName });
  fireEvent.mouseEnter(trigger.parentElement as HTMLElement);
  act(() => {
    vi.advanceTimersByTime(200);
  });
}

describe("ReplayControls", () => {
  it("renders time display with font-mono", () => {
    renderControls({ durationMs: 123_456 });
    const timeElements = screen.getAllByText(/02:03|02:04/);
    expect(timeElements.length).toBeGreaterThan(0);
  });

  it("calls onPlayPause when play/pause button is clicked", () => {
    const { props } = renderControls({ state: state("ready") });
    const playButton = screen.getByRole("button", { name: /播放|暂停/ });
    fireEvent.click(playButton);
    expect(props.onPlayPause).toHaveBeenCalledTimes(1);
  });

  it("disables play/pause button in loading/seeking/error states", () => {
    const { rerender, props } = renderControls({ state: state("loading") });
    expect(screen.getByRole("button", { name: /播放|暂停/ })).toBeDisabled();

    rerender(<ReplayControls {...props} state={state("seeking")} />);
    expect(screen.getByRole("button", { name: /播放|暂停/ })).toBeDisabled();

    rerender(<ReplayControls {...props} state={state("error")} />);
    expect(screen.getByRole("button", { name: /播放|暂停/ })).toBeDisabled();
  });

  it("calls onMuted when mute toggle is pressed", () => {
    const { props } = renderControls({ muted: false });
    const muteButton = screen.getByRole("button", { name: /静音|取消静音/ });
    fireEvent.click(muteButton);
    expect(props.onMuted).toHaveBeenCalledTimes(1);
  });

  it("clamps timeline time within 0 and duration", () => {
    renderControls({
      state: state("playing", { timelineTimeMs: -1000 }),
      durationMs: 100_000,
    });
    const timeElements = screen.getAllByText(/00:00/);
    expect(timeElements.length).toBeGreaterThan(0);
  });

  it("handles zero duration gracefully", () => {
    renderControls({ durationMs: 0 });
    expect(screen.getByRole("slider", { name: "播放进度" })).toBeDisabled();
    expect(screen.getAllByText("00:00")).toHaveLength(2);
  });

  it("does not render activity density as a second progress timeline", () => {
    const { container } = renderControls({
      durationMs: 60_000,
      activityDensity: [
        { kind: "edit", startMs: 0, endMs: 10_000, count: 3, eventSeqs: [1, 2, 3] },
        { kind: "run", startMs: 20_000, endMs: 30_000, count: 1, eventSeqs: [4] },
        { kind: "error", startMs: 40_000, endMs: 50_000, count: 1, eventSeqs: [5] },
        { kind: "silence", startMs: 50_000, endMs: 60_000, count: 0, eventSeqs: [] },
      ],
    });

    expect(screen.getAllByRole("slider", { name: "播放进度" })).toHaveLength(1);
    expect(container.querySelector("[data-replay-activity-markers]")).not.toBeInTheDocument();
  });

  it.each(["loading", "seeking", "error"] as const)(
    "disables progress seeking while status is %s",
    (status) => {
      const onSeek = vi.fn();
      renderControls({
        state: state(status, { timelineTimeMs: 20_000 }),
        durationMs: 100_000,
        onSeek,
      });

      const progressSlider = screen.getByRole("slider", { name: "播放进度" });
      expect(progressSlider).toBeDisabled();

      fireEvent.change(progressSlider, { target: { value: "25" } });
      fireEvent.mouseUp(progressSlider);

      expect(onSeek).not.toHaveBeenCalled();
    },
  );

  describe("handleSliderCommit logic", () => {
    it("updates preview locally while dragging and delegates seek without forcing playback", async () => {
      const onSeek = vi.fn();
      renderControls({ durationMs: 100_000, onSeek });

      const progressSlider = screen.getByRole("slider", { name: "播放进度" });
      fireEvent.change(progressSlider, { target: { value: "25" } });

      expect(screen.getByText("00:25")).toBeInTheDocument();
      expect(onSeek).not.toHaveBeenCalled();

      fireEvent.mouseUp(progressSlider);

      await waitFor(() => expect(onSeek).toHaveBeenCalledWith(25_000));
    });

    it("keeps a slight drag preview while playback advances before commit", () => {
      const onSeek = vi.fn();
      const { rerender, props } = renderControls({
        durationMs: 100_000,
        onSeek,
        state: state("playing", { timelineTimeMs: 50_000 }),
      });

      const progressSlider = screen.getByRole("slider", { name: "播放进度" });
      fireEvent.change(progressSlider, { target: { value: "50.1" } });

      rerender(
        <ReplayControls
          {...props}
          state={state("playing", { timelineTimeMs: 50_050 })}
        />,
      );

      expect(progressSlider).toHaveValue("50.1");
      expect(onSeek).not.toHaveBeenCalled();
    });

    it("does not issue playback while an async seek is pending", async () => {
      let resolveSeek: () => void = () => {};
      const onSeek = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSeek = resolve;
          }),
      );
      renderControls({ durationMs: 120_000, onSeek });

      const progressSlider = screen.getByRole("slider", { name: "播放进度" });
      fireEvent.change(progressSlider, { target: { value: "50" } });
      fireEvent.mouseUp(progressSlider);

      expect(onSeek).toHaveBeenCalledWith(60_000);
      expect(progressSlider).toHaveValue("50");
      expect(screen.getByText("01:00")).toBeInTheDocument();

      await act(async () => {
        resolveSeek();
      });
    });

    it("keeps a committed long-recording seek preview until scheduler is within a small time window", async () => {
      const onSeek = vi.fn();
      const durationMs = 3_600_000;
      const { rerender, props } = renderControls({
        durationMs,
        onSeek,
        state: state("playing", { timelineTimeMs: 600_000 }),
      });

      const progressSlider = screen.getByRole("slider", { name: "播放进度" });
      fireEvent.change(progressSlider, { target: { value: "50" } });
      fireEvent.mouseUp(progressSlider);

      await waitFor(() => expect(onSeek).toHaveBeenCalledWith(1_800_000));

      rerender(
        <ReplayControls
          {...props}
          state={state("playing", { timelineTimeMs: 1_796_500 })}
        />,
      );
      await act(async () => {});

      expect(progressSlider).toHaveValue("50");
      expect(screen.getByText("30:00")).toBeInTheDocument();
    });

    it("releases a committed long-recording seek preview when scheduler enters the settle window", async () => {
      const onSeek = vi.fn();
      const durationMs = 3_600_000;
      const { rerender, props } = renderControls({
        durationMs,
        onSeek,
        state: state("playing", { timelineTimeMs: 600_000 }),
      });

      const progressSlider = screen.getByRole("slider", { name: "播放进度" });
      fireEvent.change(progressSlider, { target: { value: "50" } });
      fireEvent.mouseUp(progressSlider);

      await waitFor(() => expect(onSeek).toHaveBeenCalledWith(1_800_000));

      rerender(
        <ReplayControls
          {...props}
          state={state("playing", { timelineTimeMs: 1_799_950 })}
        />,
      );
      await act(async () => {});

      expect(Number((progressSlider as HTMLInputElement).value)).toBeCloseTo(49.9986, 4);
    });
  });

  describe("volume control logic", () => {
    it("renders muted volume as zero in text and slider position", () => {
      vi.useFakeTimers();
      renderControls({ muted: true, volume: 80 });

      openHoverPopover("取消静音");

      expect(screen.getByText("0")).toBeInTheDocument();
      expect(screen.getByRole("slider", { name: "音量" })).toHaveValue("0");
    });

    it("unmutes when volume is raised while muted", () => {
      const onMuted = vi.fn();
      const onVolume = vi.fn();
      vi.useFakeTimers();
      renderControls({ muted: true, volume: 0, onMuted, onVolume });

      openHoverPopover("取消静音");
      fireEvent.change(screen.getByRole("slider", { name: "音量" }), { target: { value: "35" } });

      expect(onMuted).toHaveBeenCalledWith(false);
      expect(onVolume).toHaveBeenCalledWith(35);
    });

    it("mutes when volume reaches zero", () => {
      const onMuted = vi.fn();
      const onVolume = vi.fn();
      vi.useFakeTimers();

      renderControls({ muted: false, volume: 50, onMuted, onVolume });
      openHoverPopover("静音");
      fireEvent.change(screen.getByRole("slider", { name: "音量" }), { target: { value: "0" } });

      expect(onMuted).toHaveBeenCalledWith(true);
      expect(onVolume).toHaveBeenCalledWith(0);
    });

    it("does not submit duplicate volume updates on commit", () => {
      const onMuted = vi.fn();
      const onVolume = vi.fn();
      vi.useFakeTimers();

      renderControls({ muted: false, volume: 50, onMuted, onVolume });
      openHoverPopover("静音");
      const volumeSlider = screen.getByRole("slider", { name: "音量" });
      fireEvent.change(volumeSlider, { target: { value: "70" } });
      fireEvent.mouseUp(volumeSlider);

      expect(onMuted).not.toHaveBeenCalled();
      expect(onVolume).toHaveBeenCalledOnce();
      expect(onVolume).toHaveBeenCalledWith(70);
    });
  });

  describe("playback rate control", () => {
    it("calls onRate when a playback rate is selected", () => {
      vi.useFakeTimers();
      const { props } = renderControls();

      openHoverPopover("倍速");

      fireEvent.click(screen.getByRole("option", { name: "1.5x" }));

      expect(props.onRate).toHaveBeenCalledWith(1.5);
    });

    it("keeps the rate popover open when moving from trigger to portal content", () => {
      vi.useFakeTimers();
      renderControls();
      const rateButton = screen.getByLabelText("倍速");

      openHoverPopover("倍速");

      const rateList = screen.getByRole("listbox");
      fireEvent.mouseLeave(rateButton.parentElement as HTMLElement);
      fireEvent.mouseEnter(rateList.parentElement as HTMLElement);
      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(screen.getByRole("option", { name: "1.5x" })).toBeInTheDocument();
    });
  });
});
