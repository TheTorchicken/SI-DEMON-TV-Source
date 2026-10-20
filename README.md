# SI-DEMON-TV

A self-hosted Tesla entertainment dashboard with YouTube phone controls and Apple screen mirroring. The interface runs in the car browser; your own relay handles media and authentication.

Original project code is **source-available under [PolyForm Noncommercial 1.0.0](LICENSE)**. You may use, modify, fork and redistribute it for noncommercial purposes under that license. Commercial use is not granted. Third-party components retain their own terms; see [THIRD_PARTY.md](THIRD_PARTY.md). This is an independent project, not affiliated with Tesla or YouTube.

## Features

- YouTube search, links, phone TV-code pairing, queue management, saved videos, playback, seek and resume.
- iPhone/iPad screen and app audio through ReplayKit; macOS screen/window/app sharing with system audio through ScreenCaptureKit.
- Quality and Low latency modes, timestamped picture/audio pacing, hardware H.264 and JPEG fallback.
- Authenticated HTTP/WebSockets, one-time pairing phrases, persistent queue/receiver state and automatic reconnection.
- Canvas-based video rendering, fullscreen controls and a screen/sound diagnostic.

The owner confirmed flawless in-motion passenger playback during a freeway test on 2026-10-20. This is evidence for that installation, not a vehicle/software compatibility matrix. See [ACCEPTANCE.md](ACCEPTANCE.md) for current evidence and remaining checks. Built-in games and independent rear-screen sessions are deferred.

## Run the dashboard and relay

Requirements: **Node 24+, FFmpeg and yt-dlp** on the relay host. Native apps are optional senders. No relay, credentials or media subscriptions are provided by this repository.

```sh
npm ci
cp .env.example .env
npm run doctor
npm run build
npm start
```

Open **http://127.0.0.1:8787** on the relay host. Loopback bootstrap obtains the generated key. Private state is stored in ignored `.data/`: `token`, `state.json`, `cast.json` and `pairing.json`. Do not commit or share this directory.

For frontend development, run `npm run dev` with the relay running in another terminal. Vite proxies API/WebSocket traffic to loopback port 8787.

## Use it from the car

The browser and sender must be able to reach your relay over HTTPS/WSS. GitHub Pages can host the dashboard, but cannot run the relay or media tools. See [docs/HOSTING.md](docs/HOSTING.md) for reverse-proxy and always-on Mac examples.

1. Set `FRONTEND_ORIGINS` in the relay's `.env` to include your dashboard's exact origin.
2. For a separately hosted dashboard, set `VITE_RELAY_URL` before `npm run build`. Otherwise enter the relay address in Connection.
3. Save the relay address and key in the dashboard. Existing settings are remembered in that browser.
4. Pair YouTube through **Link with TV code** in the official phone app, or start an Apple broadcast and select Mirror.
5. Enable sound in the dashboard; browsers require a user gesture.

Set up while parked. A passenger should operate entertainment controls while the vehicle is moving. The application does not modify vehicle firmware or driving controls.

## Apple senders

Requirements: Xcode and XcodeGen. Copy the local configuration and edit the team, unique bundle ID and optional public URLs:

```sh
cp Config.local.xcconfig.example Config.local.xcconfig
```

The override is ignored by Git. Put no relay keys in build settings. Stored Keychain connections take precedence over optional default URLs. Keep the same team and bundle ID when updating an existing installation so its Keychain access remains intact.

### iPhone / iPad

```sh
npm run ios:generate
open ios/SIDemonTV.xcodeproj
```

Build/install using your Apple development account. The host app and ReplayKit extension share a signing team and Keychain group. Enter the relay address/key, save, then use Apple's broadcast button. The extension identifier is derived from the app identifier. Start and stop capture yourself; microphone capture is off. ReplayKit capture requires a physical device.

### Mac

```sh
npm run macos:build
```

The signed app and ZIP are written under `macos/build/`. Open the app, enter a key or pairing phrase, and choose a source with Apple's screen-sharing picker. Capture starts only after source selection. See [docs/MACOS.md](docs/MACOS.md) for use and native testing.

## YouTube integration

TV-code controls use the pinned `yt-cast-receiver` revision; media extraction uses your separately installed yt-dlp/FFmpeg. Provider changes can break pairing or extraction. Some content needs your own private cookie file (`YTDLP_COOKIES`); no account or subscription is supplied. Extraction is capped at 720p; Quality changes relay encoding, not source resolution. Protected apps may withhold mirrored picture/audio.

All clients connected to one relay share one receiver, queue and active Apple broadcaster. Starting another broadcast replaces the previous one. Independent sessions are not implemented.

## Verification and contributions

```sh
npm test
npm run build
npm run format:check
npm audit --audit-level=moderate
```

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [docs/PROTOCOL.md](docs/PROTOCOL.md) and [ACCEPTANCE.md](ACCEPTANCE.md).

The Pages workflow is manual and gated by `PUBLISH_APPROVED=true`. Configure the optional repository variable `PUBLIC_RELAY_URL` for your own deployment. Forks should configure their own relay, secrets and Apple signing identities.
