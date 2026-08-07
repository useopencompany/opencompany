import CryptoKit
import Foundation
import Security

enum PKCE {
  static func generateVerifier(byteCount: Int = 32) throws -> String {
    var bytes = [UInt8](repeating: 0, count: byteCount)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    guard status == errSecSuccess else {
      throw PKCEError.randomGenerationFailed(status)
    }
    return Data(bytes).base64URLEncodedString()
  }

  static func challenge(for verifier: String) -> String {
    Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
  }
}

enum PKCEError: LocalizedError {
  case randomGenerationFailed(OSStatus)

  var errorDescription: String? {
    switch self {
    case .randomGenerationFailed(let status):
      "Could not create secure OAuth state (\(status))."
    }
  }
}

extension Data {
  func base64URLEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
