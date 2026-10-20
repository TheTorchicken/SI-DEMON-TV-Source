# Verification and device evidence

## Owner test

On **2026-10-20**, the owner reported fully testing the dashboard as a passenger during freeway driving and described playback as “works flawless in motion.” This confirms in-motion playback on the tested installation and replaces its previous pending status. The application does not change vehicle firmware or driving controls.

The test did not include a separately recorded firmware/hardware matrix, frame-rate trace or camera-based latency measurement. Those details must not be invented or generalized to every Tesla.

| Area                                      | Evidence                                                                                | Status                                                                |
| ----------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Tesla in-motion playback                  | Owner's reported successful freeway passenger test                                      | Confirmed on owner's installation                                     |
| YouTube playback and controls             | Real browser playback, phone pairing observed, queue/resume tests                       | Implemented and exercised                                             |
| Quality / Low latency                     | Both profiles, real encoded burst tests, timing regressions                             | Implemented; no numerical in-car latency claim                        |
| iPhone / iPad sender                      | Signed builds/installations; real iPhone H.264/audio broadcast observed                 | Implemented; comprehensive per-device matrix not recorded             |
| Mac sender                                | Signed build opens; real VideoToolbox/audio tests; native sender through isolated relay | Implemented; real Mac-to-Tesla capture/latency check remains          |
| Reconnection and persistence              | Socket lifecycle, keyframe, audio scheduling and checkpoint regressions                 | Automated checks pass; prolonged physical interruption matrix remains |
| Independent rear session / built-in games | Explicitly deferred                                                                     | Outside current release                                               |

## Automated baseline

Before and after release cleanup, **31 tests across 9 files** and the TypeScript/Vite build passed. The cleaned source also passed formatting checks, the dependency audit (zero reported vulnerabilities), a signed iOS build and all five native Mac tests. Five native Mac tests also passed during sender development, covering proportional dimensions, credential-safe URLs, real H.264 encoding/timestamps, PCM conversion and the actual sender streaming generated frames through an isolated relay.

The real H.264 desktop burst test presented all 360 frames at 1280 × 720, with 34 ms p95/max frame intervals, zero scheduled audio gaps and zero audio-buffer cancellations under 300 ms delivery bursts. The YouTube path was separately checked with 600 ms delivery bursts and no detected post-startup audio underruns. These are synthetic desktop measurements, not measured Tesla frame rates or total game latency.

Run the commands in README.md for current results. Tests cover auth/origin boundaries, malformed commands/media packets, pairing expiry/one-time use, receiver identity, queue order, resume checkpoints, signed-source recovery, ordered decoding and audio pacing. Never replace physical evidence with a successful build.

## Useful follow-up checks

- Record vehicle firmware and infotainment hardware when reporting compatibility.
- Exercise actual iPad games and compare both modes with an external camera showing sender and receiver.
- Test interruption/recovery, portrait/landscape changes and prolonged audio sync on each physical sender.
- Verify the complete phone queue sequence after upstream YouTube changes: enqueue, advance, pause, seek and reconnect.
