import AppKit
import ScreenCaptureKit
import SwiftUI

@MainActor
final class MirrorModel: NSObject, ObservableObject, SCContentSharingPickerObserver,
  SCStreamDelegate
{
  @Published var address: String
  @Published var key: String
  @Published var mode = MirrorMode.quality
  @Published var systemAudio = true
  @Published private(set) var active = false
  @Published private(set) var preparing = false
  @Published private(set) var status = "Ready"
  @Published private(set) var error = ""
  @Published private(set) var detail = ""
  private let sender = MirrorSender()
  private var stream: SCStream?
  private var filter: SCContentFilter?
  private var connection: RelayConnection?
  private var profile = MirrorProfile()
  private var generation = UUID()
  private var operation: Task<Void, Never>?

  override init() {
    let saved = MacSettings.load()
    address = saved.address
    key = saved.key
    super.init()
    let picker = SCContentSharingPicker.shared
    var config = SCContentSharingPickerConfiguration()
    config.allowedPickerModes = [.singleDisplay, .singleWindow, .singleApplication]
    config.excludedBundleIDs = [Bundle.main.bundleIdentifier ?? "org.example.sidemon.mac"]
    picker.defaultConfiguration = config
    picker.add(self)
    sender.onProfile = { [weak self] profile in
      Task { @MainActor in
        guard let self, self.active else { return }
        self.profile = profile
        self.mode = profile.mode
        await self.updateCapture()
      }
    }
    sender.onConnection = { [weak self] connected in
      Task { @MainActor in
        guard let self, self.active else { return }
        self.status = connected ? "Sharing" : "Reconnecting…"
      }
    }
    sender.onFailure = { [weak self] message in Task { @MainActor in self?.stop(message: message) }
    }
    sender.onStats = { [weak self] fps, width, height, format in
      Task { @MainActor in
        guard let self, self.active else { return }
        self.detail = "\(width) × \(height)  ·  \(fps) fps  ·  \(format.uppercased())"
      }
    }
  }
  var dashboardURL: URL? {
    let configured = Bundle.main.object(forInfoDictionaryKey: "DemonDashboardURL") as? String ?? ""
    return try? RelayConnection(
      address: configured.isEmpty ? address : configured, key: "link-validation"
    ).base
  }
  func choose() {
    guard !preparing else { return }
    if active, let stream {
      SCContentSharingPicker.shared.present(for: stream)
      return
    }
    preparing = true
    status = "Connecting…"
    error = ""
    let current = generation
    operation = Task {
      do {
        let entered = try RelayConnection(address: address, key: key)
        let connected = try await entered.authenticated()
        // A one-time pairing phrase is immediately replaced in Keychain.
        try MacSettings.save(connected)
        guard current == generation, !Task.isCancelled else { return }
        connection = connected
        key = connected.key
        address = connected.base.absoluteString
        status = "Choose a source"
        SCContentSharingPicker.shared.isActive = true
        SCContentSharingPicker.shared.present()
      } catch { if current == generation { stop(message: friendly(error)) } }
    }
  }
  func changeMode(_ next: MirrorMode) {
    mode = next
    guard active, let connection else { return }
    let current = generation
    Task {
      do {
        _ = try await connection.request(
          "api/command", body: ["type": "mode", "mode": next.rawValue])
      } catch { if current == generation { self.error = friendly(error) } }
    }
  }
  func stop(message: String = "") {
    generation = UUID()
    operation?.cancel()
    operation = nil
    sender.stop()
    let old = stream
    stream = nil
    filter = nil
    connection = nil
    SCContentSharingPicker.shared.isActive = false
    active = false
    preparing = false
    status = "Ready"
    detail = ""
    error = message
    if let old { Task { try? await old.stopCapture() } }
  }
  private func configuration(for filter: SCContentFilter) -> SCStreamConfiguration {
    let config = SCStreamConfiguration()
    let size = profile.dimensions(
      for: CGSize(
        width: filter.contentRect.width * CGFloat(filter.pointPixelScale),
        height: filter.contentRect.height * CGFloat(filter.pointPixelScale)))
    config.width = size.width
    config.height = size.height
    config.minimumFrameInterval = CMTime(value: 1, timescale: Int32(profile.fps))
    config.queueDepth = profile.mode == .quality ? 5 : 3
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.showsCursor = true
    config.scalesToFit = true
    config.preservesAspectRatio = true
    config.capturesAudio = systemAudio
    config.excludesCurrentProcessAudio = true
    config.sampleRate = 44100
    config.channelCount = 1
    config.streamName = "SI-DEMON-TV"
    return config
  }
  private func updateCapture() async {
    guard let stream, let filter else { return }
    let current = generation
    do { try await stream.updateConfiguration(configuration(for: filter)) } catch {
      if current == generation {
        stop(message: "Capture settings could not update. Start sharing again.")
      }
    }
  }
  private func begin(_ filter: SCContentFilter) {
    let current = generation
    operation = Task {
      do {
        if let stream, active {
          self.filter = filter
          try await stream.updateContentFilter(filter)
          await updateCapture()
          return
        }
        guard let connection else { return }
        _ = try await connection.request(
          "api/command", body: ["type": "mode", "mode": mode.rawValue])
        _ = try await connection.request(
          "api/command", body: ["type": "screen", "screen": "mirror"])
        guard current == generation, !Task.isCancelled else { return }
        profile = MirrorProfile(mode: mode)
        self.filter = filter
        let stream = SCStream(
          filter: filter, configuration: configuration(for: filter), delegate: self)
        try stream.addStreamOutput(sender, type: .screen, sampleHandlerQueue: sender.captureQueue)
        if systemAudio {
          try stream.addStreamOutput(sender, type: .audio, sampleHandlerQueue: sender.captureQueue)
        }
        self.stream = stream
        active = true
        preparing = false
        status = "Connecting…"
        sender.start(connection: connection, mode: mode)
        try await stream.startCapture()
        if current != generation { try? await stream.stopCapture() }
      } catch {
        if current == generation {
          stop(
            message:
              "Screen sharing could not start. Choose a source again; check Screen & System Audio Recording in System Settings if access was denied."
          )
        }
      }
    }
  }
  private func friendly(_ error: Error) -> String {
    if error is MirrorError { return error.localizedDescription }
    return "The relay could not connect. Check its address and your Internet connection."
  }
  nonisolated func contentSharingPicker(
    _ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?
  ) {
    Task { @MainActor in
      guard self.preparing || self.active else { return }
      self.begin(filter)
    }
  }
  nonisolated func contentSharingPicker(
    _ picker: SCContentSharingPicker, didCancelFor stream: SCStream?
  ) {
    Task { @MainActor in if !self.active { self.stop() } }
  }
  nonisolated func contentSharingPickerStartDidFailWithError(_ error: Error) {
    Task { @MainActor in self.stop(message: "The screen picker could not open. Try again.") }
  }
  nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
    Task { @MainActor in
      guard self.stream === stream else { return }
      self.stop(message: "Screen sharing ended. Choose a source to start again.")
    }
  }
}
