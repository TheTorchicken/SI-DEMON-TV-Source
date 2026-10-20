# Contributing

Keep changes focused and explain the behavior they change. Playback timing, H.264 reference ordering, audio scheduling, saved receiver identity and pause/resume checkpoints are particularly sensitive. Preserve their regression tests; do not weaken assertions to make a change pass.

## Development

Use Node 24 or later, FFmpeg and yt-dlp. Run `npm ci`, `npm start` and, in another terminal, `npm run dev`. The development dashboard proxies API and media sockets to loopback port 8787. Native apps additionally require Xcode and XcodeGen; signing setup is in the README.

Before submitting a change:

```sh
npm test
npm run build
npm run format:check
npm audit --audit-level=moderate
```

For native changes, build the affected app and run the Mac tests where relevant. Format Swift with `xcrun swift-format format --in-place` on the changed files. Generated Xcode projects and build products are ignored.

Describe what changed, why, how it was checked and any device-specific gaps. A synthetic stream or successful build does not demonstrate capture permissions, audible output, game latency or compatibility with another Tesla/software version. Keep physical test reports separate from automated evidence.

Never include relay keys, pairing secrets, cookies, device identifiers, signing credentials, private network inventories or captured screen/audio in issues or pull requests. Use generated test patterns and temporary relay directories. Changes to the live service or publishing workflow are separate from ordinary code contributions.
