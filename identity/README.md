# SI-DEMON-TV identity — demon Tesla v1

Owner direction: a real logo and app icon of a red, demon-like superintelligent Tesla. Built with the requested image-generation tool on 2026-10-20.

- `logo/demon-tesla-v1.png`: standalone emblem, RGBA, 1254 × 1254, transparent background.
- `iconography/demon-tesla-appicon-v1.png`: matching graphite-tile Mac app icon, RGBA, 1254 × 1254, transparent corners and outer margin.
- `prompts.md`: exact final logo and icon prompts; built-in image generation, no CLI fallback.

The Model 3 front, smooth nose, focused headlight eyes, red roof horns and central hood crease form one mark. Red tonal planes create depth; silver headlights and graphite negative space retain definition. No lettering is baked into either asset. The existing SI-DEMON-TV title remains live text in the app.

The Mac app uses the generated emblem inside its window and packages the generated tile into ICNS sizes from 16 to 1024 pixels. Original generated PNGs are kept unmodified. At very small sizes, recognition rests on the paired horns, red body silhouette and white headlight eyes; panel detail is secondary. These are raster masters, not hand-built vector files or a claim of single-color reproduction.

The owner approved applying the identity to web, iOS and macOS on 2026-10-20. `swift scripts/export-brand.swift` exports the approved artwork to the website, home-screen icons and iOS asset catalog; the iOS app icon is an opaque 1024-pixel PNG. The Mac build packages the matching generated tile as ICNS. Original masters remain unchanged. The legacy `chicken.svg` URL contains an embedded export of the new Tesla mark for cached clients; it no longer contains the chicken artwork.
