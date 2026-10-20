import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const digest = (phrase: string) =>
  createHash("sha256")
    .update(phrase.trim().toLowerCase().replace(/\s+/g, "-"))
    .digest();

// One active, short-lived code. Only a holder of the full key can issue one.
export class Pairing {
  private attempts = 0;
  private window = 0;
  constructor(private file: string) {}
  issue() {
    const digits = randomInt(100_000_000).toString().padStart(8, "0");
    const phrase = `ultra-red-${digits.slice(0, 4)}-${digits.slice(4)}`;
    const expires = Date.now() + 30 * 60_000;
    writeFileSync(
      this.file,
      JSON.stringify({ hash: digest(phrase).toString("hex"), expires }),
      { mode: 0o600 },
    );
    return { phrase, expires };
  }
  redeem(phrase: unknown): "accepted" | "invalid" | "limited" {
    if (Date.now() - this.window >= 60_000) {
      this.window = Date.now();
      this.attempts = 0;
    }
    if (++this.attempts > 5) return "limited";
    if (typeof phrase !== "string" || phrase.length > 100) return "invalid";
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (
        !Number.isFinite(saved.expires) ||
        saved.expires <= Date.now() ||
        !/^[a-f0-9]{64}$/.test(saved.hash)
      )
        return "invalid";
      if (!timingSafeEqual(digest(phrase), Buffer.from(saved.hash, "hex")))
        return "invalid";
      unlinkSync(this.file);
      return "accepted";
    } catch {
      return "invalid";
    }
  }
}
