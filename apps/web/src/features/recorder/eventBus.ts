import { generateId } from "@/shared/util/ids";
import type {
  EventBus,
  EventBusInput,
  RecordingClock,
  RecordingEvent,
  RecordingEventType,
} from "@/shared/recording-schema";

export type EventBusOptions = {
  clock: RecordingClock;
  wallTimeProvider?: () => string;
};

/**
 * EventBus — ingest channel from Producers to RecordingController.
 *
 * Contract:
 * - Every emitted event gets a strictly monotonic `seq` starting at 1.
 * - `timestampMs` is read from the RecordingClock at emit time, so it already
 *   excludes paused intervals.
 * - `peek()` returns a frozen snapshot; `drain()` resets the internal buffer
 *   (used at package build time to avoid double-collection).
 * - Subscribers see every event in arrival order; reset() also notifies nobody —
 *   it is a controller-only action.
 */
export function createEventBus(options: EventBusOptions): EventBus {
  const { clock } = options;
  const wallTimeProvider = options.wallTimeProvider ?? (() => new Date().toISOString());

  let nextSeq = 1;
  let lastSeq = 0;
  const buffer: RecordingEvent[] = [];
  const listeners = new Set<(event: RecordingEvent) => void>();

  return {
    emit<TType extends RecordingEventType>(
      input: EventBusInput<TType>,
    ): Extract<RecordingEvent, { type: TType }> {
      const seq = nextSeq;
      nextSeq += 1;
      const event = {
        id: generateId("e"),
        seq,
        timestampMs: clock.now(),
        wallTime: input.wallTime ?? wallTimeProvider(),
        source: input.source,
        track: input.track,
        type: input.type,
        payload: input.payload,
      } as Extract<RecordingEvent, { type: TType }>;
      lastSeq = seq;
      buffer.push(event);
      listeners.forEach((listener) => listener(event));
      return event;
    },
    drain() {
      const out = buffer.slice();
      buffer.length = 0;
      return out;
    },
    peek() {
      return Object.freeze(buffer.slice());
    },
    lastSeq() {
      return lastSeq;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      nextSeq = 1;
      lastSeq = 0;
      buffer.length = 0;
    },
  };
}
