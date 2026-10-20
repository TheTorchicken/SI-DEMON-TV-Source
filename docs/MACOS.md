# Mac mirroring sender

Native SwiftUI / ScreenCaptureKit sender for macOS 14 and later. The personal build targets Apple silicon and uses the team configured in the ignored `Config.local.xcconfig`. The app connects to the same authenticated Studio relay as iPhone/iPad. It has no Node, FFmpeg, tunnel or web-server dependency at runtime.

## Use

1. Open **SI-DEMON-TV Mac.app**. Enter your own relay address; an optional default can be configured at build time.
2. Enter the connection key or a current one-time pairing phrase. Successful connections are saved in macOS Keychain; the full key replaces a redeemed phrase immediately.
3. Choose Quality or Low latency and whether to include system audio.
4. Click **Choose screen or window**, then select the source in Apple's picker. Sharing begins only after this selection. A Mac broadcast replaces any active phone/iPad broadcast on this single-session relay.
5. Open the Tesla dashboard, select Mirror and enable sound. Mode changes from either screen are applied through the relay.
6. Use **Change source** to choose another display/window/app. **Stop**, Escape, Command-period, closing the window or quitting ends sharing. System Settings may request Screen & System Audio Recording access; approve it yourself if desired. The microphone is never captured.

System audio follows Apple's selected-content filter. Protected content may withhold video/audio. Selecting a full display includes anything subsequently visible on that display. The app does not automatically start at login or resume capture after quitting, and does not save captured media to disk.

## Build and test

Requires Xcode, XcodeGen and your own development signing identity; copy and edit `Config.local.xcconfig.example` as described in README.md. The app shares the actual H.264 encoder source with iOS. For the isolated relay integration test, install the repository's existing Node dependencies with `npm ci` first.

```sh
cd macos
zsh build.sh
xcodebuild -project SIDemonMac.xcodeproj -scheme SIDemonMac \
  -configuration Debug -destination 'platform=macOS' -derivedDataPath build test
```

The signed Release app is `macos/build/Build/Products/Release/SI-DEMON-TV Mac.app`; the ZIP is `macos/build/SI-DEMON-TV-Mac.zip`. This is a personal development-signed build, not a notarized public distribution. Development signing identity/profile validity still applies.

Five native tests cover URL/credential boundaries, proportional dimensions/profile limits, actual VideoToolbox Annex-B output/timestamps, real Float32 audio conversion/packet timing, and the actual native sender streaming generated frames through an isolated relay with H.264 negotiation. That test neither captures the desktop nor connects to the owner's live relay. Real selected-content capture, audible system output, network recovery and Mac-to-Tesla latency still require a user-operated check.

## Sender behavior

Quality retains a 1280-pixel long edge, 30 fps cap and 5 Mbps average H.264; Low latency uses 720 pixels / 30 fps / 1.8 Mbps. The receiver supplies 650 ms / 60 ms presentation buffering. macOS produces frames only when content updates, so a static window can show a lower actual sent frame rate. Sizing preserves source aspect ratio; a resized source is fitted into the current stream until reselected or reconfigured.

ScreenCaptureKit scales capture directly, with a bounded 5/3-frame capture queue. Ingress retains one newest pending video sample; one encoded video send is in flight. Compressed frames use the existing ordered protocol and encoder peak limits. Audio work and outgoing sends are bounded; presentation timestamps share a capture clock. A stalled send reconnects rather than retaining an old frame indefinitely. Another broadcaster's replacement close code ends capture rather than fighting for the relay.

Connection redirects are rejected so bearer keys cannot move to an unexpected host. HTTPS is required except for explicit loopback test addresses. The key is not bundled, logged or put into UserDefaults.

## Interface decisions

The existing Ultra Red palette is retained: Ultra Red `#DC2941`, graphite `#0E0F12`, raised graphite `#181A1D`, silver `#E8EBF0` and secondary gray `#9399A3`. Rounded SF text belongs to the Mac controls; SF Mono is reserved for live transport measurements. One left-aligned window contains source/status, connection fields, playback controls and the sharing action. The demon Tesla mark and sharing button carry the visual emphasis. There are no promotional headings, feature cards or ownership reminders. The generated logo and matching Dock icon are sourced from `identity/`; see its README and prompt record. macOS icon resolutions are packaged by `build.sh` from the generated PNG, without replacing the logo artwork with code-drawn graphics.

The window deliberately has no live capture preview: source selection belongs to Apple's picker, and the receiver already presents the picture. Only user-visible status and measured send rate are shown.
