import AppKit
import CoreImage
import ImageIO
import ScreenCaptureKit

/// All codec/socket state belongs to work; capture ingress retains at most one video sample.
final class MirrorSender: NSObject, SCStreamOutput, URLSessionWebSocketDelegate {
  var onProfile: ((MirrorProfile) -> Void)?
  var onConnection: ((Bool) -> Void)?
  var onFailure: ((String) -> Void)?
  var onStats: ((Int, Int, Int, String) -> Void)?
  private let work = DispatchQueue(label: "sidemon.mac.sender", qos: .userInteractive)
  let captureQueue = DispatchQueue(label: "sidemon.mac.capture", qos: .userInteractive)
  private let lock = NSLock()
  private var pendingVideo: CMSampleBuffer?
  private var videoScheduled = false
  private var queuedAudio = 0
  private var accepting = false
  private var running = false
  private var socketReady = false
  private var socket: URLSessionWebSocketTask?
  private var session: URLSession?
  private var socketURL: URL?
  private var reconnects = 0
  private var retry: DispatchWorkItem?
  private var profile = MirrorProfile()
  private let encoder = VideoEncoder()
  private var audioEncoder = MirrorAudioEncoder()
  private let context = CIContext(options: [.cacheIntermediates: false])
  private var forceKey = true
  private var busy = false
  private var sendingVideo = false
  private var videoTimestamp = Double.nan
  private var pendingAudio = 0
  private var lastTimestamp = -Double.infinity
  private var statsAt = CACurrentMediaTime()
  private var sentFrames = 0
  private var outputSize = CGSize.zero

  func start(connection: RelayConnection, mode: MirrorMode) {
    lock.lock()
    accepting = true
    lock.unlock()
    work.async {
      self.running = true
      self.profile = MirrorProfile(mode: mode)
      self.socketURL = connection.socketURL
      self.reconnects = 0
      self.statsAt = CACurrentMediaTime()
      self.sentFrames = 0
      self.encoder.onConfig = { [weak sender = self] codec, timestamp in
        sender?.work.async { [weak sender] in
          guard let self = sender, self.running, self.socketReady, self.videoTimestamp == timestamp
          else { return }
          self.sendJSON(["type": "codec", "codec": codec])
        }
      }
      self.encoder.onFrame = { [weak sender = self] bytes, key, timestamp in
        sender?.work.async { [weak sender] in
          guard let self = sender, self.running, self.socketReady, self.videoTimestamp == timestamp
          else { return }
          self.sendVideo(MirrorPacket.video(bytes, keyframe: key, timestamp: timestamp))
        }
      }
      self.connect()
    }
  }
  func stop() {
    lock.lock()
    accepting = false
    pendingVideo = nil
    lock.unlock()
    work.async {
      self.running = false
      self.retry?.cancel()
      self.retry = nil
      self.socket?.cancel(with: .normalClosure, reason: nil)
      self.session?.invalidateAndCancel()
      self.socket = nil
      self.session = nil
      self.socketReady = false
      self.busy = false
      self.pendingAudio = 0
      self.videoTimestamp = .nan
      self.encoder.invalidate()
    }
  }
  private func connect() {
    guard running, let socketURL else { return }
    let config = URLSessionConfiguration.ephemeral
    config.timeoutIntervalForRequest = 15
    let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    self.session = session
    let task = session.webSocketTask(with: socketURL)
    socket = task
    socketReady = false
    busy = false
    sendingVideo = false
    videoTimestamp = .nan
    pendingAudio = 0
    forceKey = true
    lastTimestamp = -.infinity
    encoder.invalidate()
    audioEncoder = MirrorAudioEncoder()
    task.resume()
    receive(task)
  }
  func urlSession(
    _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    work.async {
      guard self.running, self.socket === webSocketTask else { return }
      self.socketReady = true
      self.sendJSON(["type": "hello", "device": "Mac"])
      self.onConnection?(true)
    }
  }
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
  private func receive(_ task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      self?.work.async { [weak self] in
        guard let self, self.running, self.socket === task else { return }
        switch result {
        case .success(let message):
          self.reconnects = 0
          if case .string(let text) = message, let data = text.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
          {
            if json["type"] as? String == "keyframe" { self.forceKey = true }
            if let next = MirrorProfile(message: json) {
              if next != self.profile {
                self.encoder.invalidate()
                self.busy = false
                self.sendingVideo = false
                self.videoTimestamp = .nan
                self.profile = next
                self.onProfile?(next)
              }
              self.encoder.bitRate = next.bitrate
              self.encoder.frameRate = Int32(next.fps)
              self.forceKey = true
            }
          }
          self.receive(task)
        case .failure: self.reconnect(task)
        }
      }
    }
  }
  private func reconnect(_ task: URLSessionWebSocketTask) {
    guard running, socket === task else { return }
    let replaced = task.closeCode.rawValue == 4001
    socket = nil
    socketReady = false
    task.cancel(with: .goingAway, reason: nil)
    session?.invalidateAndCancel()
    session = nil
    busy = false
    sendingVideo = false
    videoTimestamp = .nan
    encoder.invalidate()
    onConnection?(false)
    if replaced || reconnects >= 6 {
      running = false
      onFailure?(
        replaced
          ? "Another device started sharing. Start again when it has finished."
          : "The relay disconnected. Check the connection and start again.")
      return
    }
    let delay = min(0.5 * pow(2, Double(reconnects)), 5)
    reconnects += 1
    let retry = DispatchWorkItem { [weak self] in self?.connect() }
    self.retry = retry
    work.asyncAfter(deadline: .now() + delay, execute: retry)
  }
  private func sendJSON(_ json: [String: Any]) {
    guard let task = socket, let data = try? JSONSerialization.data(withJSONObject: json),
      let text = String(data: data, encoding: .utf8)
    else { return }
    task.send(.string(text)) { [weak self] error in
      if error != nil { self?.work.async { [weak self] in self?.reconnect(task) } }
    }
  }
  func stream(
    _ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of outputType: SCStreamOutputType
  ) {
    accept(sampleBuffer, type: outputType)
  }
  func accept(_ sampleBuffer: CMSampleBuffer, type outputType: SCStreamOutputType) {
    guard sampleBuffer.isValid else { return }
    lock.lock()
    guard accepting else {
      lock.unlock()
      return
    }
    if outputType == .screen {
      pendingVideo = sampleBuffer
      let schedule = !videoScheduled
      videoScheduled = true
      lock.unlock()
      if schedule {
        work.async {
          self.lock.lock()
          let latest = self.pendingVideo
          self.pendingVideo = nil
          self.videoScheduled = false
          self.lock.unlock()
          if let latest { self.video(latest) }
        }
      }
    } else if outputType == .audio {
      guard queuedAudio < 32 else {
        lock.unlock()
        return
      }
      queuedAudio += 1
      lock.unlock()
      work.async {
        self.audio(sampleBuffer)
        self.lock.lock()
        self.queuedAudio -= 1
        self.lock.unlock()
      }
    } else {
      lock.unlock()
    }
  }
  private func video(_ sample: CMSampleBuffer) {
    guard running, socketReady, !busy,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
        as? [[SCStreamFrameInfo: Any]],
      let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue,
      let buffer = CMSampleBufferGetImageBuffer(sample)
    else { return }
    let timestamp = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1000
    guard timestamp.isFinite, timestamp - lastTimestamp >= 900 / Double(profile.fps) else { return }
    lastTimestamp = timestamp
    busy = true
    sendingVideo = false
    videoTimestamp = timestamp
    outputSize = CGSize(
      width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer))
    autoreleasepool {
      if profile.format == "h264" {
        let key = forceKey
        forceKey = false
        encoder.bitRate = profile.bitrate
        encoder.frameRate = Int32(profile.fps)
        encoder.encode(buffer, timestamp: timestamp, keyFrame: key)
        work.asyncAfter(deadline: .now() + 0.3) {
          guard self.busy, !self.sendingVideo, self.videoTimestamp == timestamp else { return }
          self.encoder.invalidate()
          self.busy = false
          self.forceKey = true
        }
      } else {
        guard let color = CGColorSpace(name: CGColorSpace.sRGB),
          let jpeg = context.jpegRepresentation(
            of: CIImage(cvPixelBuffer: buffer), colorSpace: color,
            options: [
              kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: profile
                .jpeg
            ])
        else {
          busy = false
          return
        }
        sendVideo(MirrorPacket.jpeg(jpeg, timestamp: timestamp))
      }
    }
  }
  private func sendVideo(_ packet: Data) {
    guard let task = socket else {
      busy = false
      return
    }
    let timestamp = videoTimestamp
    sendingVideo = true
    task.send(.data(packet)) { [weak self] error in
      self?.work.async { [weak self] in
        guard let self, self.socket === task, self.videoTimestamp == timestamp else { return }
        self.busy = false
        self.sendingVideo = false
        if error != nil {
          self.reconnect(task)
          return
        }
        self.sentFrames += 1
        let now = CACurrentMediaTime()
        let elapsed = now - self.statsAt
        if elapsed >= 1 {
          self.onStats?(
            Int((Double(self.sentFrames) / elapsed).rounded()), Int(self.outputSize.width),
            Int(self.outputSize.height), self.profile.format)
          self.sentFrames = 0
          self.statsAt = now
        }
      }
    }
    // A blocked uplink must not hold an old screen forever.
    work.asyncAfter(deadline: .now() + 2) {
      if self.socket === task && self.busy && self.sendingVideo && self.videoTimestamp == timestamp
      {
        self.reconnect(task)
      }
    }
  }
  private func audio(_ sample: CMSampleBuffer) {
    guard running, socketReady, pendingAudio < (profile.mode == .quality ? 32 : 8),
      let task = socket, let packet = audioEncoder.packet(sample)
    else { return }
    pendingAudio += 1
    task.send(.data(packet)) { [weak self] error in
      self?.work.async { [weak self] in
        guard let self, self.socket === task else { return }
        self.pendingAudio = max(0, self.pendingAudio - 1)
        if error != nil { self.reconnect(task) }
      }
    }
  }
}
