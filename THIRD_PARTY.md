# Third-party components and license boundaries

The project's original code is under [PolyForm Noncommercial 1.0.0](LICENSE), as selected by the owner. It permits noncommercial use, changes and redistribution subject to its terms. It does not replace licenses on third-party code, and must not be described as an OSI-approved open-source license.

- **JSMpeg** — MIT; vendored browser decoder from [phoboslab/jsmpeg](https://github.com/phoboslab/jsmpeg). Its notice is included at `public/vendor/JSMpeg.LICENSE` and must be retained.
- **yt-cast-receiver** — MIT, [patrickkfkan/yt-cast-receiver](https://github.com/patrickkfkan/yt-cast-receiver), pinned to commit `83d61fa169e33c5e0046c2440b99a17cd9493e73`.
- **peer-dial / peer-ssdp forks** — installed dependency license files contain LGPL v3 text. The receiver's upstream README additionally describes peer-dial as free for noncommercial use. Preserve those licenses and notices; this project does not resolve that upstream ambiguity or grant commercial rights to those components. See the [receiver's license section](https://github.com/patrickkfkan/yt-cast-receiver#license) and [original peer-dial license section](https://github.com/fraunhoferfokus/peer-dial#license).
- **React, Express, ws, qrcode, Vite, Vitest, TypeScript, tsx, Prettier and transitive dependencies** — retain their npm package license files. `package-lock.json` pins the dependency graph; install them with `npm ci`.
- **FFmpeg and yt-dlp** — external tools, not bundled. Their own licenses and the enabled codecs/build configuration apply.
- **Outfit** — Google Fonts / SIL Open Font License. The dashboard uses a system-font fallback if the external font is unavailable.
- **Apple frameworks** — system SDK/runtime dependencies used by the native senders; not redistributed by this source repository.
- **Project logo/icon** — generated for this project; masters and generation prompts are in `identity/`. No Tesla or YouTube endorsement or trademark rights are conveyed.

No CyberDash source or branding is included. HotspotNav was a research reference; its code was not copied. The application does not bundle YouTube videos, source-app media or account subscriptions.
