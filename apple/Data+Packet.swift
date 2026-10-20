import Foundation

// Shared little-endian wire encoding for both native senders.
extension Data {
  mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
    var number = value.littleEndian
    Swift.withUnsafeBytes(of: &number) { append(contentsOf: $0) }
  }
  mutating func appendDouble(_ value: Double) { appendLE(value.bitPattern) }
}
