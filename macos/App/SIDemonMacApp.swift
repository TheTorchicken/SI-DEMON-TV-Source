import AppKit
import SwiftUI

@main struct SIDemonMacApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
  @StateObject private var model = MirrorModel()
  var body: some Scene {
    Window("SI-DEMON-TV", id: "sender") {
      SenderView(model: model)
        .preferredColorScheme(.dark)
        .onAppear { delegate.model = model }
    }
    .defaultSize(width: 540, height: 570)
    .windowResizability(.contentSize)
    .commands {
      CommandGroup(after: .appInfo) {
        Button("Stop sharing") { model.stop() }
          .keyboardShortcut(".", modifiers: [.command])
          .disabled(!model.active && !model.preparing)
      }
    }
  }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
  weak var model: MirrorModel?
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
  func applicationWillTerminate(_ notification: Notification) { model?.stop() }
}

private enum Theme {
  static let logo: NSImage = {
    guard let url = Bundle.main.url(forResource: "DemonTeslaLogo", withExtension: "png"),
      let image = NSImage(contentsOf: url)
    else {
      return NSImage(systemSymbolName: "display", accessibilityDescription: nil)!
    }
    return image
  }()
  static let red = Color(red: 0.86, green: 0.16, blue: 0.25)
  static let graphite = Color(red: 0.055, green: 0.060, blue: 0.070)
  static let panel = Color(red: 0.095, green: 0.102, blue: 0.115)
  static let silver = Color(red: 0.91, green: 0.92, blue: 0.94)
}

struct SenderView: View {
  @ObservedObject var model: MirrorModel
  private var mode: Binding<MirrorMode> {
    Binding(get: { model.mode }, set: { model.changeMode($0) })
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .center) {
        Text("SI-DEMON-TV").font(.system(size: 16, weight: .bold, design: .rounded))
        Spacer()
        HStack(spacing: 7) {
          Circle().fill(model.active ? Theme.red : Color.secondary).frame(width: 6, height: 6)
          Text(model.status).font(.system(size: 12, weight: .medium))
        }.foregroundStyle(.secondary)
          .accessibilityElement(children: .combine)
      }
      .padding(.bottom, 30)

      HStack(alignment: .center, spacing: 22) {
        Image(nsImage: Theme.logo)
          .renderingMode(.original)
          .resizable()
          .scaledToFit()
          .padding(4)
          .frame(width: 90, height: 88)
          .background(Theme.panel, in: RoundedRectangle(cornerRadius: 18))
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 6) {
          Text("Screen mirroring")
            .font(.system(size: 28, weight: .semibold, design: .rounded))
          Text(model.detail.isEmpty ? "Mac → Tesla" : model.detail)
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(.secondary)
        }
      }.padding(.bottom, 28)

      if !model.active {
        VStack(alignment: .leading, spacing: 8) {
          Text("Relay address").font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)
          TextField("Relay address", text: $model.address)
            .textContentType(.URL).accessibilityLabel("Relay address")
          Text("Connection key or pairing phrase").font(.system(size: 12, weight: .medium))
            .foregroundStyle(.secondary).padding(.top, 8)
          SecureField("Connection key or pairing phrase", text: $model.key)
            .accessibilityLabel("Connection key or pairing phrase")
        }
        .textFieldStyle(.roundedBorder).controlSize(.large)
        .disabled(model.preparing)
        .padding(.bottom, 24)
      }

      HStack(spacing: 24) {
        Picker("Playback mode", selection: mode) {
          ForEach(MirrorMode.allCases, id: \.self) { Text($0.title).tag($0) }
        }.pickerStyle(.segmented).labelsHidden().accessibilityLabel("Playback mode")
        Toggle("System audio", isOn: $model.systemAudio)
          .toggleStyle(.checkbox).disabled(model.active || model.preparing)
      }.disabled(model.preparing).padding(.bottom, 24)

      if !model.error.isEmpty {
        Text(model.error).font(.system(size: 12)).foregroundStyle(Theme.silver)
          .padding(12).frame(maxWidth: .infinity, alignment: .leading)
          .background(Theme.red.opacity(0.16), in: RoundedRectangle(cornerRadius: 8))
          .textSelection(.enabled).padding(.bottom, 16)
      }

      HStack(spacing: 12) {
        Button {
          model.choose()
        } label: {
          Label(
            model.active
              ? "Change source" : model.preparing ? "Choose a source…" : "Choose screen or window",
            systemImage: "macwindow.badge.plus"
          )
          .frame(maxWidth: .infinity).padding(.vertical, 9)
        }
        .buttonStyle(.borderedProminent).tint(Theme.red)
        .keyboardShortcut(.return, modifiers: [])
        .disabled(
          model.preparing || model.key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        if model.active || model.preparing {
          Button("Stop") { model.stop() }.controlSize(.large)
            .keyboardShortcut(.escape, modifiers: [])
        }
      }
      Spacer(minLength: 24)
      HStack {
        Text("Microphone off").font(.system(size: 11)).foregroundStyle(.secondary)
        Spacer()
        if let url = model.dashboardURL {
          Link("Open Tesla screen ↗", destination: url)
            .font(.system(size: 11)).foregroundStyle(Theme.silver)
        }
      }
    }
    .padding(30)
    .frame(width: 540, alignment: .topLeading)
    .frame(minHeight: model.active ? 370 : 570)
    .foregroundStyle(Theme.silver)
    .background(Theme.graphite)
    .tint(Theme.red)
  }
}
