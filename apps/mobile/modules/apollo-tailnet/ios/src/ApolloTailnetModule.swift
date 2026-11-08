import ExpoModulesCore
import Foundation

public class ApolloTailnetModule: Module {
  // Every Go and keychain call is blocking; keep them off the main and JS threads,
  // one at a time.
  private let queue = DispatchQueue(label: "dev.ocx64.apollo.tailnet", qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("ApolloTailnet")

    OnCreate {
      #if DEBUG || APOLLO_TAILNET_SELFTEST
      TailnetSelfTest.runIfRequested(on: self.queue)
      #endif
    }

    AsyncFunction("tailnetStart") { () throws -> [String: Any?] in
      Self.normalize(try TailnetBridge.start())
    }.runOnQueue(queue)

    AsyncFunction("tailnetStatus") { () throws -> [String: Any?] in
      Self.normalize(try TailnetBridge.status())
    }.runOnQueue(queue)

    AsyncFunction("tailnetStop") { () throws in
      try TailnetBridge.stop()
    }.runOnQueue(queue)

    AsyncFunction("tailnetLogout") { () throws in
      try TailnetBridge.logout()
    }.runOnQueue(queue)

    AsyncFunction("tailnetForward") { (host: String, port: Int, nodeId: String, userId: String) throws -> [String: Int] in
      let out = try TailnetBridge.forward(host: host, port: port, nodeId: nodeId, userId: userId)
      guard let localPort = (out["localPort"] as? NSNumber)?.intValue else {
        throw TailnetException("forwarder returned no port")
      }
      return ["localPort": localPort]
    }.runOnQueue(queue)

    AsyncFunction("tailnetStopForward") { () throws in
      try TailnetBridge.stopForward()
    }.runOnQueue(queue)

    AsyncFunction("deviceKeyPublic") { () throws -> [String: Any] in
      let (publicKey, hardware) = try DeviceKey.publicKey()
      return ["publicKey": publicKey, "hardware": hardware]
    }.runOnQueue(queue)

    AsyncFunction("deviceKeySign") { (message: String) throws -> String in
      try DeviceKey.sign(message)
    }.runOnQueue(queue)

    AsyncFunction("deviceKeyDelete") { () throws in
      try DeviceKey.delete()
    }.runOnQueue(queue)
  }

  /// Fixed key set with explicit nulls, so JS always sees every field.
  private static func normalize(_ raw: [String: Any]) -> [String: Any?] {
    func str(_ key: String) -> String? { raw[key] as? String }
    return [
      "state": str("state") ?? "NoState",
      "authUrl": str("authUrl"),
      "nodeId": str("nodeId"),
      "userId": str("userId"),
      "loginName": str("loginName"),
      "dnsName": str("dnsName"),
    ]
  }
}
