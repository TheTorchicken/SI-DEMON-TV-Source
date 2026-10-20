# Hosting your own relay

The dashboard is static; the relay runs Node, FFmpeg and yt-dlp. Host the relay on an always-on computer you control. No shared project relay or subscription service is included.

## Local process

```sh
npm ci
cp .env.example .env
npm run build
npm start
```

The default bind is `127.0.0.1:8787`. Put your HTTPS reverse proxy or approved tunnel in front of this loopback listener. Keep `.data` and `.env` private. Install FFmpeg/yt-dlp yourself and ensure they are in the service's PATH, or configure their explicit paths.

For a hosted dashboard, include its exact origin in `FRONTEND_ORIGINS`. Configure `VITE_RELAY_URL=https://relay.example.com/sidemon` at dashboard build time, or let the user enter it in Connection. A URL is public configuration; a relay key is not.

## HTTPS reverse proxy

`deploy/mac-studio/nginx-location.conf` is an example location block for an existing HTTPS server. It preserves WebSocket upgrades, strips the `/sidemon/` prefix, permits 4 MiB packets and disables access logging of socket URLs because their query strings contain the relay key. Integrate it into your own configuration, validate with `nginx -t`, and retain a rollback copy before reload. DNS, certificates and gateway administration are outside the app.

Verify after deployment:

- `/sidemon/api/health` returns readiness.
- Unauthenticated `/sidemon/api/state` returns 401; public `/sidemon/api/bootstrap` returns 403.
- Your allowed dashboard origin works; untrusted origins are rejected.
- Authenticated media sockets work through HTTPS/WSS, not just local HTTP.

Do not expose the YouTube DIAL port publicly. Manual TV-code pairing is the intended remote connection flow.

## Existing SSH gateway option

If you already administer an HTTPS gateway, a separate reverse SSH forward can connect its loopback proxy port to your relay:

```sh
ssh -N -i ~/.ssh/your_relay_gateway_key \
  -o BatchMode=yes -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=yes -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -R 127.0.0.1:8787:127.0.0.1:8787 relay@gateway.example.com
```

Provision and verify your own host key/key-based access first. Use a dedicated account/key with only the access you intend. The command does not create a gateway, DNS entry or certificate. Do not change unrelated applications' tunnels or routes.

## macOS LaunchAgents

Example templates are in `deploy/mac-studio/`. Copy them outside the checkout, replace every `__PLACEHOLDER__`, and validate the result with `plutil -lint` before loading it under your own user. Set the correct Node executable, project directory, SSH identity and gateway user/host. These templates are examples, not automatically installed services.

LaunchAgents run when the account is logged in. The host must stay awake and connected. Preserve `.data` when updating source, and stop the relay gracefully with SIGTERM so saved playback checkpoints are retained. Do not copy another installation's relay key or receiver identity.

## GitHub Pages

Enable Pages/GitHub Actions in your repository, set `PUBLISH_APPROVED=true`, and optionally set `PUBLIC_RELAY_URL` to your public relay address. Run the dashboard workflow manually. The browser stores its own connection, so the key is never bundled in the published files.

Pages cannot accept Apple broadcasts or run media tools. Configure a real HTTPS relay before testing from the car.
