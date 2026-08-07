import Foundation

struct GoatQuickConfiguration: Equatable, Sendable {
  let apiBaseURL: URL
  let oauthIssuer: URL
  let oauthClientID: String

  static func load(bundle: Bundle = .main) throws -> GoatQuickConfiguration {
    let apiBaseURL = try configuredURL(named: "GoatAPIBaseURL", bundle: bundle)
    let oauthIssuer = try configuredURL(named: "GoatOAuthIssuer", bundle: bundle)
    guard let oauthClientID = bundle.object(forInfoDictionaryKey: "GoatOAuthClientID") as? String,
      !oauthClientID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
      throw ConfigurationError.missing("GoatOAuthClientID")
    }

    return GoatQuickConfiguration(
      apiBaseURL: apiBaseURL,
      oauthIssuer: oauthIssuer,
      oauthClientID: oauthClientID.trimmingCharacters(in: .whitespacesAndNewlines)
    )
  }

  private static func configuredURL(named key: String, bundle: Bundle) throws -> URL {
    guard let rawValue = bundle.object(forInfoDictionaryKey: key) as? String,
      let url = URL(string: rawValue.trimmingCharacters(in: .whitespacesAndNewlines)),
      let scheme = url.scheme?.lowercased(),
      scheme == "https" || (scheme == "http" && url.host == "127.0.0.1")
    else {
      throw ConfigurationError.missing(key)
    }
    return url
  }
}

enum ConfigurationError: LocalizedError {
  case missing(String)

  var errorDescription: String? {
    switch self {
    case .missing(let key):
      "Set \(key) in Config/Local.xcconfig before running opencompany Quick."
    }
  }
}
