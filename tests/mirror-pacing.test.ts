import { expect, it } from "vitest";
import {
  MirrorClock,
  MirrorFrames,
  type MirrorFrame,
} from "../src/mirror-playback";

it("turns bursty 30 fps Quality frames into evenly paced picture updates", () => {
  const clock = new MirrorClock("quality"),
    queue = new MirrorFrames(clock);
  let produced = 0,
    closed = 0;
  const shown: number[] = [];
  for (let tick = 0; tick <= 180; tick++) {
    const now = (tick * 1000) / 60;
    const available = (Math.floor(now / 300) + 1) * 9;
    while (produced < available) {
      const timestamp = 100_000 + (produced++ * 1000) / 30;
      clock.observe(timestamp, now);
      queue.push({
        image: {} as CanvasImageSource,
        width: 1280,
        height: 720,
        timestamp,
        close() {
          closed++;
        },
      });
    }
    const frame = queue.due(now);
    if (frame) {
      shown.push(frame.timestamp);
      frame.close();
    }
    if (now < 650) expect(shown).toHaveLength(0);
  }
  expect(shown.length).toBeGreaterThanOrEqual(70);
  expect(shown.length).toBeLessThanOrEqual(72);
  for (let frame = 1; frame < shown.length; frame++)
    expect(shown[frame] - shown[frame - 1]).toBeCloseTo(1000 / 30);
  queue.clear();
  expect(closed).toBe(produced);
});

it("keeps Low latency near the latest input instead of accumulating a large delayed burst", () => {
  const clock = new MirrorClock("latency"),
    queue = new MirrorFrames(clock);
  let closed = 0;
  for (let frame = 0; frame < 30; frame++) {
    const timestamp = (frame * 1000) / 30;
    clock.observe(timestamp, 0);
    queue.push({
      image: {} as CanvasImageSource,
      width: 720,
      height: 406,
      timestamp,
      close() {
        closed++;
      },
    });
  }
  expect(clock.time((29 * 1000) / 30)).toBeLessThanOrEqual(180);
  const latest = queue.due(200)!;
  expect(latest.timestamp).toBe((29 * 1000) / 30);
  latest.close();
  queue.clear();
  expect(closed).toBe(30);
});

it("renders only the newest due decoded frame after a slow paint and releases every older image", () => {
  const clock = new MirrorClock("quality"),
    queue = new MirrorFrames(clock);
  clock.observe(0, 0);
  const released: number[] = [];
  for (let frame = 0; frame < 12; frame++)
    queue.push({
      image: {} as CanvasImageSource,
      width: 1280,
      height: 720,
      timestamp: (frame * 1000) / 30,
      close() {
        released.push(frame);
      },
    } satisfies MirrorFrame);
  const latest = queue.due(1000)!;
  expect(latest.timestamp).toBeCloseTo((10 * 1000) / 30);
  expect(released).toHaveLength(10);
  latest.close();
  queue.clear();
  expect([...released].sort((a, b) => a - b)).toEqual(
    Array.from({ length: 12 }, (_, i) => i),
  );
});
