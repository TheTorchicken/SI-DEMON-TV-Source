# Public source release

## License

Original project code is licensed under **PolyForm Noncommercial 1.0.0**. Noncommercial use, modifications, forks and redistribution are permitted subject to the standard license and required notice. Commercial use is not granted. The exact terms, including the standard provisions for noncommercial organizations, control over this summary.

This is a source-available release. Do not call it MIT, unrestricted commercial software or an OSI-approved open-source project. Third-party code retains the separate terms documented in THIRD_PARTY.md.

## Release cleanup

- Shared Apple H.264 encoding and little-endian packet helpers live under `apple/`.
- Swift and TypeScript source are consistently formatted; a pinned formatter and contribution checks are included.
- Signing teams, bundle IDs and optional default URLs are local configuration rather than personal constants in source.
- Hosted dashboard URLs and allowed origins are deployment configuration.
- Hosting examples use placeholders; old private machine/network inventory is excluded from the public snapshot.
- README and the acceptance ledger record the owner's confirmed in-motion passenger test.

The playback codecs, target bitrates, frame caps and buffering targets are preserved. The live personal relay and installed senders are separate from this source release.

## Evidence

On 2026-10-20, the cleanup passed 31 Node tests across nine files, TypeScript/Vite build, formatting checks, dependency audit, signed iOS build and five native Mac tests. The existing relay key was not found in committed history during the private release audit. A credential-pattern hit in the vendored decoder was identified as data inside its WebAssembly base64 literal.

The public repository starts from a clean source snapshot. Prior personal deployment history, live keys/state, signing overrides, cookie files and native build products are not included. Physical game-latency measurements and a broader device compatibility matrix remain separate work; source cleanup does not establish those results.
