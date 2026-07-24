import Foundation
import Security

protocol RefreshTokenStore: AnyObject {
  func load() throws -> String?
  func save(_ token: String) throws
  func clear() throws
}

final class KeychainRefreshTokenStore: RefreshTokenStore {
  private let service: String
  private let account: String

  init(
    service: String = Bundle.main.bundleIdentifier ?? "com.opencompany.goat.quick",
    account: String = "workos-refresh-token"
  ) {
    self.service = service
    self.account = account
  }

  func load() throws -> String? {
    var result: CFTypeRef?
    var query = identityQuery
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data,
      let token = String(data: data, encoding: .utf8)
    else {
      throw KeychainError.operationFailed(status)
    }
    return token
  }

  func save(_ token: String) throws {
    let data = Data(token.utf8)
    var query = identityQuery
    let status = SecItemUpdate(
      query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      query[kSecValueData as String] = data
      query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      let addStatus = SecItemAdd(query as CFDictionary, nil)
      guard addStatus == errSecSuccess else {
        throw KeychainError.operationFailed(addStatus)
      }
      return
    }
    guard status == errSecSuccess else {
      throw KeychainError.operationFailed(status)
    }
  }

  func clear() throws {
    let status = SecItemDelete(identityQuery as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw KeychainError.operationFailed(status)
    }
  }

  private var identityQuery: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }
}

enum KeychainError: LocalizedError {
  case operationFailed(OSStatus)

  var errorDescription: String? {
    switch self {
    case .operationFailed(let status):
      "Keychain operation failed (\(status))."
    }
  }
}
