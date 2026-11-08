import Foundation
import Security

/// A P-256 signing key that never leaves this device: in the Secure Enclave when
/// there is one, otherwise (simulator) a software key in the keychain. Both are
/// AfterFirstUnlockThisDeviceOnly and need no user presence to sign.
enum DeviceKey {
  static let tag = Data("dev.ocx64.apollo.devicekey".utf8)

  struct Loaded {
    let key: SecKey
    let hardware: Bool
  }

  static func loadOrCreate() throws -> Loaded {
    if let found = try load() { return found }
    return try create()
  }

  /// base64url (no padding) of the 65-byte X9.63 uncompressed public point.
  static func publicKey() throws -> (publicKey: String, hardware: Bool) {
    let loaded = try loadOrCreate()
    guard let pub = SecKeyCopyPublicKey(loaded.key) else { throw TailnetException("device key has no public key") }
    var error: Unmanaged<CFError>?
    guard let raw = SecKeyCopyExternalRepresentation(pub, &error) as Data? else {
      throw TailnetException("export public key: \(describe(error))")
    }
    return (base64url(raw), loaded.hardware)
  }

  /// ECDSA P-256 / SHA-256 over the UTF-8 message, DER signature, base64url.
  static func sign(_ message: String) throws -> String {
    let loaded = try loadOrCreate()
    var error: Unmanaged<CFError>?
    guard let sig = SecKeyCreateSignature(
      loaded.key, .ecdsaSignatureMessageX962SHA256, Data(message.utf8) as CFData, &error
    ) as Data? else {
      throw TailnetException("sign: \(describe(error))")
    }
    return base64url(sig)
  }

  static func delete() throws {
    let status = SecItemDelete(baseQuery() as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw TailnetException("delete device key: OSStatus \(status)")
    }
  }

  // MARK: - keychain

  private static func baseQuery() -> [String: Any] {
    [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPrivate,
    ]
  }

  private static func load() throws -> Loaded? {
    var query = baseQuery()
    query[kSecReturnRef as String] = true
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let attrs = item as? [String: Any], let ref = attrs[kSecValueRef as String] else {
      throw TailnetException("read device key: OSStatus \(status)")
    }
    let token = attrs[kSecAttrTokenID as String] as? String
    return Loaded(key: ref as! SecKey, hardware: token == (kSecAttrTokenIDSecureEnclave as String))
  }

  private static func create() throws -> Loaded {
    #if !targetEnvironment(simulator)
    if let key = try? createSecureEnclave() { return Loaded(key: key, hardware: true) }
    #endif
    return Loaded(key: try createSoftware(), hardware: false)
  }

  private static func createSecureEnclave() throws -> SecKey {
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
      nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &error
    ) else {
      throw TailnetException("access control: \(describe(error))")
    }
    let attrs: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: tag,
        kSecAttrAccessControl as String: access,
      ] as [String: Any],
    ]
    guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else {
      throw TailnetException("create Secure Enclave key: \(describe(error))")
    }
    return key
  }

  private static func createSoftware() throws -> SecKey {
    var error: Unmanaged<CFError>?
    let attrs: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: tag,
        kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      ] as [String: Any],
    ]
    guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else {
      throw TailnetException("create device key: \(describe(error))")
    }
    return key
  }

  private static func describe(_ error: Unmanaged<CFError>?) -> String {
    guard let e = error?.takeRetainedValue() else { return "unknown error" }
    return (e as Error).localizedDescription
  }

  static func base64url(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
