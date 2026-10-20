// Isolated native-sender integration fixture. Never connects to the owner's relay.
import { createRelay } from "../../server/index.ts";
import { validateMirrorPacket } from "../../server/core.ts";
import { WebSocket } from "ws";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "sidemon-mac-test-"));
const relay = createRelay({ directory, token: "synthetic-mac-test" });
await new Promise((resolve) => relay.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${relay.server.address().port}`;
const viewer = new WebSocket(
  base.replace("http:", "ws:") + "/ws/mirror?token=synthetic-mac-test",
);
const received = { h264: 0, pcm: 0, codecs: 0, invalid: 0 };
viewer.on("message", (data, binary) => {
  if (!binary) {
    if (JSON.parse(data.toString()).type === "codec") received.codecs++;
    return;
  }
  const type = validateMirrorPacket(Buffer.from(data));
  if (type === "h264") received.h264++;
  else if (type === "pcm") received.pcm++;
  else received.invalid++;
});
await new Promise((resolve) => viewer.once("open", resolve));
viewer.send(JSON.stringify({ type: "format", format: "h264" }));
relay.store.patch({ mode: "quality" });
relay.app.get("/test/metrics", (_req, res) => res.json(received));
process.stdout.write(base + "\n");
writeFileSync(process.argv[2], base);
process.once("SIGTERM", async () => {
  viewer.terminate();
  await relay.close();
  rmSync(directory, { recursive: true });
  process.exit();
});
