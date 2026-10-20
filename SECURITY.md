# Security reports

Use the repository's private vulnerability reporting channel when available. If private reporting is unavailable, open a minimal issue requesting a private contact without posting credentials, exploit details or captured media.

The relay key grants control of playback and access to mirrored media. Keep `.data`, `.env`, cookie files and `Config.local.xcconfig` private. Use HTTPS/WSS outside explicit loopback development. Reverse proxies must not log WebSocket query strings, which contain the key. Do not expose the DIAL discovery port publicly.

The relay stores queue/receiver state and authentication data locally. Captured screen/audio is forwarded rather than recorded to disk by the application. Your operating system, proxy and source apps have their own privacy behavior.

This project has no hosted account system or shared relay for contributors. Each installation needs its own secret and hosting. Keys and receiver identities must not be reused in published examples.
