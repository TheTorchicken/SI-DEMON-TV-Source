import ReplayKit
import SwiftUI

@main struct SIDemonApp: App {
  var body: some Scene { WindowGroup { SetupView().preferredColorScheme(.dark) } }
}
struct SetupView: View {
  @State private var relay = BroadcastSettings.relay
  @State private var key = BroadcastSettings.key
  @State private var saved = false
  @State private var message = ""
  private let accent = Color(red: 0.86, green: 0.16, blue: 0.25)
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 25) {
        HStack(spacing: 13) {
          Image("DemonTeslaLogo").resizable().scaledToFit().frame(width: 52, height: 52)
          Text("SI-DEMON-TV").font(.title2.bold())
        }.padding(.top, 35)
        Text("Screen broadcast").font(.system(size: 38, weight: .semibold, design: .rounded))
        Text("Connect to the relay, start a broadcast, then open the app to mirror.")
          .foregroundStyle(.secondary)
        VStack(alignment: .leading, spacing: 12) {
          Text("Relay address").font(.subheadline)
          TextField("https://your-relay.example", text: $relay).keyboardType(.URL)
            .textInputAutocapitalization(.never).autocorrectionDisabled().padding().background(
              .white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
          Text("Connection key").font(.subheadline).padding(.top, 8)
          SecureField("Connection key", text: $key).textInputAutocapitalization(.never)
            .autocorrectionDisabled().padding().background(
              .white.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
          Button {
            save()
          } label: {
            Text(saved ? "Settings saved" : "Save connection").fontWeight(.semibold).frame(
              maxWidth: .infinity
            ).padding()
          }.buttonStyle(.plain).background(accent, in: RoundedRectangle(cornerRadius: 12))
            .foregroundStyle(.white).padding(.top, 8)
        }
        if !message.isEmpty { Text(message).font(.footnote).foregroundStyle(accent) }
        VStack(alignment: .leading, spacing: 12) {
          Text("Start broadcast").font(.title3.weight(.medium))
          HStack {
            BroadcastPicker().frame(width: 58, height: 58)
            Text("Tap the broadcast button, then choose Start Broadcast.").font(.subheadline)
              .foregroundStyle(.secondary)
          }
          Text(
            "Switch quality and low latency on the Tesla screen. Microphone capture is off; app audio is included when the source app permits it."
          ).font(.footnote).foregroundStyle(.secondary)
        }.padding(20).background(.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 18))
        Text(
          "Scan the device setup QR on the Tesla to fill these settings automatically. Stop sharing from the red broadcast indicator on this device."
        ).font(.footnote).foregroundStyle(.secondary)
      }.padding(28).frame(maxWidth: 600)
    }.frame(maxWidth: .infinity).background(Color(red: 0.06, green: 0.065, blue: 0.075))
      .onChange(of: relay) { _ in saved = false }.onChange(of: key) { _ in saved = false }
      .onOpenURL { url in
        guard url.scheme == "sidemon", url.host == "connect",
          let c = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return }
        relay = c.queryItems?.first(where: { $0.name == "url" })?.value ?? relay
        key = c.queryItems?.first(where: { $0.name == "key" })?.value ?? key
        save()
      }
  }
  private func save() {
    guard BroadcastSettings.save(relay: relay, key: key) else {
      message =
        "The connection could not be saved. Check the app’s signing and keychain entitlement."
      return
    }
    guard BroadcastSettings.socketURL() != nil else {
      message = "Enter a complete relay address and connection key."
      return
    }
    saved = true
    message = "Settings saved."
  }
}
struct BroadcastPicker: UIViewRepresentable {
  func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
    let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 58, height: 58))
    picker.preferredExtension = Bundle.main.bundleIdentifier.map { $0 + ".broadcast" }
    picker.showsMicrophoneButton = false
    return picker
  }
  func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}
