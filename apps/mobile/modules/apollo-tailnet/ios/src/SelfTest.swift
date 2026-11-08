import Foundation

#if DEBUG || APOLLO_TAILNET_SELFTEST
/// Debug-only smoke test of the native paths, run when the app is launched with
/// APOLLO_TAILNET_SELFTEST=1 (e.g. `SIMCTL_CHILD_APOLLO_TAILNET_SELFTEST=1 xcrun simctl launch --console ...`).
/// Prints one JSON line prefixed with "APOLLO_TAILNET_SELFTEST". Compiled only into Debug builds, or when
/// built with SWIFT_ACTIVE_COMPILATION_CONDITIONS containing APOLLO_TAILNET_SELFTEST.
enum TailnetSelfTest {
  static func runIfRequested(on queue: DispatchQueue) {
    guard ProcessInfo.processInfo.environment["APOLLO_TAILNET_SELFTEST"] == "1" else { return }
    queue.async {
      var out: [String: Any] = [:]
      do {
        let (pub, hw) = try DeviceKey.publicKey()
        let message = "apollo-selftest"
        out["publicKey"] = pub
        out["hardware"] = hw
        out["message"] = message
        out["signature"] = try DeviceKey.sign(message)
      } catch { out["deviceKeyError"] = "\(error)" }
      do {
        out["start"] = try TailnetBridge.start()
        out["status"] = try TailnetBridge.status()
      } catch { out["tailnetError"] = "\(error)" }
      let data = (try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys])) ?? Data()
      print("APOLLO_TAILNET_SELFTEST " + (String(data: data, encoding: .utf8) ?? "{}"))
      fflush(stdout)
    }
  }
}
#endif
