internal import ApolloTailnetGo
import ExpoModulesCore
import Foundation

/// Thin, blocking wrapper over the Go c-archive. Call only from a background queue.
enum TailnetBridge {
  static let hostname = "apollo-iphone"

  /// Application Support/apollo/tsnet, 0700, excluded from backups.
  static func stateDir() throws -> URL {
    let fm = FileManager.default
    let base = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    var dir = base.appendingPathComponent("apollo", isDirectory: true).appendingPathComponent("tsnet", isDirectory: true)
    try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: dir.path)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try dir.setResourceValues(values)
    return dir
  }

  static func start() throws -> [String: Any] {
    let dir = try stateDir().path
    return try call { withCStrings(dir, hostname) { ApolloTailnetStart($0[0], $0[1]) } }
  }

  static func status() throws -> [String: Any] {
    try call { ApolloTailnetStatus() }
  }

  static func stop() throws {
    _ = try call { ApolloTailnetStop() }
  }

  static func logout() throws {
    let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
    let dir = base.appendingPathComponent("apollo/tsnet", isDirectory: true).path
    _ = try call { withCStrings(dir) { ApolloTailnetLogout($0[0]) } }
  }

  static func forward(host: String, port: Int, nodeId: String, userId: String) throws -> [String: Any] {
    guard (1...65535).contains(port) else { throw TailnetException("port out of range") }
    return try call {
      withCStrings(host, nodeId, userId) { ApolloTailnetForward($0[0], Int32(port), $0[1], $0[2]) }
    }
  }

  static func stopForward() throws {
    _ = try call { ApolloTailnetStopForward() }
  }

  // MARK: - plumbing

  private static func call(_ fn: () -> UnsafeMutablePointer<CChar>?) throws -> [String: Any] {
    guard let raw = fn() else { throw TailnetException("tailnet returned nothing") }
    defer { ApolloTailnetFree(raw) }
    let data = Data(bytes: raw, count: strlen(raw))
    guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw TailnetException("tailnet returned malformed JSON")
    }
    if let err = obj["error"] as? String { throw TailnetException(err) }
    return obj
  }

  private static func withCStrings<R>(_ strings: String..., body: ([UnsafeMutablePointer<CChar>]) -> R) -> R {
    let ptrs = strings.map { strdup($0)! }
    defer { ptrs.forEach { free($0) } }
    return body(ptrs)
  }
}

final class TailnetException: Exception, @unchecked Sendable {
  private let text: String
  init(_ text: String, file: String = #fileID, line: UInt = #line, function: String = #function) {
    self.text = text
    super.init(file: file, line: line, function: function)
  }
  override var code: String { "ERR_APOLLO_TAILNET" }
  override var reason: String { text }
}
