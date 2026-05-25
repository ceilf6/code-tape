import { describe, expect, it } from "vitest";
import { createEventBus } from "../eventBus";
import { createRecordingClock } from "../recordingClock";

function setup() {
  let wall = 1000;
  const clock = createRecordingClock({ nowProvider: () => wall });
  const bus = createEventBus({ clock, wallTimeProvider: () => "T" });
  clock.start();
  return {
    bus,
    advance: (ms: number) => {
      wall += ms;
    },
  };
}

describe("createEventBus", () => {
  it("assigns strictly monotonic seq starting at 1", () => {
    const { bus } = setup();
    const a = bus.emit({
      type: "language-change",
      source: "editor",
      track: "main",
      payload: { from: "javascript", to: "typescript" },
    });
    const b = bus.emit({
      type: "language-change",
      source: "editor",
      track: "main",
      payload: { from: "typescript", to: "python" },
    });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  it("timestamps events using the recording clock", () => {
    const { bus, advance } = setup();
    advance(500);
    const event = bus.emit({
      type: "language-change",
      source: "editor",
      track: "main",
      payload: { from: "javascript", to: "typescript" },
    });
    expect(event.timestampMs).toBe(500);
  });

  it("drain returns all buffered events and clears buffer", () => {
    const { bus } = setup();
    bus.emit({
      type: "language-change",
      source: "editor",
      track: "main",
      payload: { from: "javascript", to: "typescript" },
    });
    expect(bus.peek().length).toBe(1);
    const drained = bus.drain();
    expect(drained.length).toBe(1);
    expect(bus.peek().length).toBe(0);
  });

  it("keeps the last emitted seq after drain and resets it on reset", () => {
    const { bus } = setup();
    expect(bus.lastSeq()).toBe(0);

    const event = bus.emit({
      type: "language-change",
      source: "editor",
      track: "main",
      payload: { from: "javascript", to: "typescript" },
    });

    expect(bus.lastSeq()).toBe(event.seq);
    bus.drain();
    expect(bus.lastSeq()).toBe(event.seq);
    bus.reset();
    expect(bus.lastSeq()).toBe(0);
  });

  it("notifies subscribers in arrival order", () => {
    const { bus } = setup();
    const seen: number[] = [];
    bus.subscribe((event) => seen.push(event.seq));
    bus.emit({
      type: "language-change",
      source: "editor",
      track: "main",
      payload: { from: "javascript", to: "typescript" },
    });
    bus.emit({
      type: "language-change",
      source: "editor",
      track: "main",
      payload: { from: "typescript", to: "python" },
    });
    expect(seen).toEqual([1, 2]);
  });

  it("reset() restarts seq from 1 and empties the buffer", () => {
    const { bus } = setup();
    bus.emit({
      type: "language-change",
      source: "editor",
      track: "main",
      payload: { from: "javascript", to: "typescript" },
    });
    bus.reset();
    expect(bus.peek().length).toBe(0);
    const next = bus.emit({
      type: "language-change",
      source: "editor",
      track: "main",
      payload: { from: "javascript", to: "python" },
    });
    expect(next.seq).toBe(1);
  });
});
