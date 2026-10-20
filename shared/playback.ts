import type { Mode } from "./types";

export function youtubeBufferSeconds(mode: Mode, remaining?: number) {
  const preferred = mode === "quality" ? 1.2 : 0.4;
  return remaining !== undefined && Number.isFinite(remaining)
    ? Math.min(preferred, Math.max(0.1, remaining / 2))
    : preferred;
}
