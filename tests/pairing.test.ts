import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pairing } from "../server/pairing";
import { Connection } from "../src/connection";

const directories: string[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "demon-pairing-"));
  directories.push(directory);
  return join(directory, "pairing.json");
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true });
});
describe("one-time pairing", () => {
  it("survives restart, accepts spaces and consumes a phrase once", () => {
    const file = setup();
    const { phrase } = new Pairing(file).issue();
    const restarted = new Pairing(file);
    expect(restarted.redeem("wrong")).toBe("invalid");
    expect(restarted.redeem(phrase.replaceAll("-", " ").toUpperCase())).toBe(
      "accepted",
    );
    expect(restarted.redeem(phrase)).toBe("invalid");
  });
  it("expires codes and bounds guesses across all clients", () => {
    vi.useFakeTimers();
    const pairing = new Pairing(setup());
    const { phrase } = pairing.issue();
    for (let i = 0; i < 5; i++) expect(pairing.redeem("wrong")).toBe("invalid");
    expect(pairing.redeem(phrase)).toBe("limited");
    vi.advanceTimersByTime(60_001);
    expect(pairing.redeem(phrase)).toBe("accepted");
    const expired = pairing.issue();
    vi.advanceTimersByTime(30 * 60_000);
    expect(pairing.redeem(expired.phrase)).toBe("invalid");
  });
  it.each(["ultra red 1234 5678", "synthetic-custom-phrase"])(
    "exchanges %s and saves the full key for sockets and reconnect",
    async (phrase) => {
      const saved = new Map<string, string>();
      vi.stubGlobal("localStorage", {
        setItem: (key: string, value: string) => saved.set(key, value),
      });
      vi.stubGlobal("location", { protocol: "https:" });
      const socketURLs: string[] = [];
      vi.stubGlobal(
        "WebSocket",
        class {
          constructor(url: string) {
            socketURLs.push(url);
          }
          close() {}
        },
      );
      const calls: { url: string; headers: Record<string, string> }[] = [];
      vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string> });
        if (url.endsWith("/api/pair"))
          return Response.json({ token: "synthetic-full-key" });
        if (
          (init.headers as Record<string, string>).Authorization !==
          "Bearer synthetic-full-key"
        )
          return Response.json(
            { error: "Connect with your relay key." },
            { status: 401 },
          );
        expect(JSON.parse(saved.get("demon.connection")!).token).toBe(
          "synthetic-full-key",
        );
        return Response.json({ status: "paused" });
      });
      const connection = new Connection(
        { url: "https://relay.test", token: phrase },
        () => {},
        () => {},
      );
      await connection.connect();
      expect(calls[2].headers.Authorization).toBe("Bearer synthetic-full-key");
      expect(new URL(socketURLs[0]).searchParams.get("token")).toBe(
        "synthetic-full-key",
      );
      connection.close();
      await connection.connect();
      expect(calls.at(-1)?.url).toBe("https://relay.test/api/state");
      expect(calls.filter((c) => c.url.endsWith("/api/pair"))).toHaveLength(1);
      connection.close();
    },
  );
});
