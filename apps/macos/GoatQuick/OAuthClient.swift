import AppKit
import Foundation

@MainActor
protocol AccessTokenProviding: AnyObject {
  var isSignedIn: Bool { get }
  func accessToken(forceRefresh: Bool) async throws -> String
}

@MainActor
final class OAuthClient: ObservableObject, AccessTokenProviding {
  typealias RequestPerformer = @MainActor @Sendable (URLRequest) async throws -> (Data, URLResponse)

  @Published private(set) var isSignedIn: Bool

  private let configuration: GoatQuickConfiguration
  private let tokenStore: RefreshTokenStore
  private let session: URLSession
  private let requestPerformer: RequestPerformer?
  private var accessTokenValue: String?
  private var accessTokenExpiresAt: Date?
  private var discovery: OAuthDiscovery?
  private var refreshTask: Task<String, Error>?
  private var activeCallbackServer: LoopbackCallbackServer?
  private var activeAuthorizationURL: URL?

  init(
    configuration: GoatQuickConfiguration,
    tokenStore: RefreshTokenStore = KeychainRefreshTokenStore(),
    session: URLSession = .shared,
    requestPerformer: RequestPerformer? = nil
  ) throws {
    self.configuration = configuration
    self.tokenStore = tokenStore
    self.session = session
    self.requestPerformer = requestPerformer
    isSignedIn = try tokenStore.load() != nil
  }

  func signIn() async throws {
    let discovery = try await loadDiscovery()
    let callbackServer = LoopbackCallbackServer()
    let redirectURI = try await callbackServer.start()
    let verifier = try PKCE.generateVerifier()
    let state = try PKCE.generateVerifier()
    let nonce = try PKCE.generateVerifier()
    let authorizationURL = try Self.authorizationURL(
      endpoint: discovery.authorizationEndpoint,
      clientID: configuration.oauthClientID,
      redirectURI: redirectURI,
      verifier: verifier,
      state: state,
      nonce: nonce
    )

    activeCallbackServer = callbackServer
    activeAuthorizationURL = authorizationURL
    defer {
      activeCallbackServer = nil
      activeAuthorizationURL = nil
    }

    guard NSWorkspace.shared.open(authorizationURL) else {
      callbackServer.cancel()
      throw OAuthError.couldNotOpenBrowser
    }

    let callback = try await callbackServer.waitForCallback()
    let code = try Self.authorizationCode(from: callback, expectedState: state)

    let token = try await exchangeCode(
      code,
      verifier: verifier,
      redirectURI: redirectURI,
      tokenEndpoint: discovery.tokenEndpoint
    )
    try accept(token)
  }

  @discardableResult
  func reopenAuthorizationPage() -> Bool {
    guard let activeAuthorizationURL else { return false }
    return NSWorkspace.shared.open(activeAuthorizationURL)
  }

  func cancelSignIn() {
    activeCallbackServer?.cancel()
  }

  func accessToken(forceRefresh: Bool = false) async throws -> String {
    if !forceRefresh,
      let accessTokenValue,
      let accessTokenExpiresAt,
      accessTokenExpiresAt.timeIntervalSinceNow > 60
    {
      return accessTokenValue
    }
    if let refreshTask { return try await refreshTask.value }

    let task = Task { @MainActor [weak self] in
      guard let self else { throw CancellationError() }
      defer { refreshTask = nil }
      return try await refreshAccessToken()
    }
    refreshTask = task
    return try await task.value
  }

  func signOut() throws {
    try tokenStore.clear()
    accessTokenValue = nil
    accessTokenExpiresAt = nil
    isSignedIn = false
  }

  private func refreshAccessToken() async throws -> String {
    guard let refreshToken = try tokenStore.load(), !refreshToken.isEmpty else {
      isSignedIn = false
      throw OAuthError.signInRequired
    }
    let discovery = try await loadDiscovery()
    var request = URLRequest(url: discovery.tokenEndpoint)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.httpBody = formEncoded([
      "grant_type": "refresh_token",
      "client_id": configuration.oauthClientID,
      "refresh_token": refreshToken,
    ])

    do {
      let token: OAuthTokenResponse = try await sendTokenRequest(request)
      try accept(token, previousRefreshToken: refreshToken)
      return token.accessToken
    } catch OAuthError.reauthenticationRequired {
      do {
        try signOut()
      } catch {
        accessTokenValue = nil
        accessTokenExpiresAt = nil
        isSignedIn = false
        throw error
      }
      throw OAuthError.signInRequired
    }
  }

  private func exchangeCode(
    _ code: String,
    verifier: String,
    redirectURI: URL,
    tokenEndpoint: URL
  ) async throws -> OAuthTokenResponse {
    var request = URLRequest(url: tokenEndpoint)
    request.httpMethod = "POST"
    request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
    request.httpBody = formEncoded([
      "grant_type": "authorization_code",
      "client_id": configuration.oauthClientID,
      "code": code,
      "code_verifier": verifier,
      "redirect_uri": redirectURI.absoluteString,
    ])
    return try await sendTokenRequest(request)
  }

  private func sendTokenRequest<T: Decodable>(_ request: URLRequest) async throws -> T {
    let (data, response) = try await data(for: request)
    guard let httpResponse = response as? HTTPURLResponse else {
      throw OAuthError.invalidResponse
    }
    guard (200..<300).contains(httpResponse.statusCode) else {
      let error = try? JSONDecoder().decode(OAuthTokenError.self, from: data)
      if error?.error == "invalid_grant" { throw OAuthError.reauthenticationRequired }
      throw OAuthError.tokenRequestFailed(
        error?.errorDescription ?? error?.error ?? "HTTP \(httpResponse.statusCode)")
    }
    do {
      return try JSONDecoder().decode(T.self, from: data)
    } catch {
      throw OAuthError.invalidResponse
    }
  }

  private func accept(_ token: OAuthTokenResponse, previousRefreshToken: String? = nil) throws {
    guard let refreshToken = token.refreshToken ?? previousRefreshToken else {
      throw OAuthError.missingRefreshToken
    }
    try tokenStore.save(refreshToken)
    accessTokenValue = token.accessToken
    accessTokenExpiresAt = Date().addingTimeInterval(TimeInterval(token.expiresIn))
    isSignedIn = true
  }

  private func loadDiscovery() async throws -> OAuthDiscovery {
    if let discovery { return discovery }
    let url = configuration.oauthIssuer.appending(path: ".well-known/oauth-authorization-server")
    let (data, response) = try await data(for: URLRequest(url: url))
    guard let httpResponse = response as? HTTPURLResponse,
      (200..<300).contains(httpResponse.statusCode),
      let discovery = try? JSONDecoder().decode(OAuthDiscovery.self, from: data)
    else {
      throw OAuthError.discoveryFailed
    }
    self.discovery = discovery
    return discovery
  }

  private func data(for request: URLRequest) async throws -> (Data, URLResponse) {
    if let requestPerformer { return try await requestPerformer(request) }
    return try await session.data(for: request)
  }

  static func authorizationURL(
    endpoint: URL,
    clientID: String,
    redirectURI: URL,
    verifier: String,
    state: String,
    nonce: String
  ) throws -> URL {
    guard var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
      throw OAuthError.discoveryFailed
    }
    components.queryItems = [
      URLQueryItem(name: "response_type", value: "code"),
      URLQueryItem(name: "client_id", value: clientID),
      URLQueryItem(name: "redirect_uri", value: redirectURI.absoluteString),
      URLQueryItem(name: "scope", value: "openid profile email offline_access"),
      URLQueryItem(name: "code_challenge", value: PKCE.challenge(for: verifier)),
      URLQueryItem(name: "code_challenge_method", value: "S256"),
      URLQueryItem(name: "state", value: state),
      URLQueryItem(name: "nonce", value: nonce),
    ]
    guard let url = components.url else { throw OAuthError.discoveryFailed }
    return url
  }

  static func authorizationCode(
    from callback: OAuthCallback,
    expectedState: String
  ) throws -> String {
    guard callback.state == expectedState else { throw OAuthError.stateMismatch }
    if let error = callback.error { throw OAuthError.authorizationFailed(error) }
    guard let code = callback.code, !code.isEmpty else { throw OAuthError.missingCode }
    return code
  }

  private func formEncoded(_ values: [String: String]) -> Data {
    var components = URLComponents()
    components.queryItems = values.sorted(by: { $0.key < $1.key }).map {
      URLQueryItem(name: $0.key, value: $0.value)
    }
    return Data((components.percentEncodedQuery ?? "").utf8)
  }
}

private struct OAuthDiscovery: Decodable {
  let authorizationEndpoint: URL
  let tokenEndpoint: URL

  enum CodingKeys: String, CodingKey {
    case authorizationEndpoint = "authorization_endpoint"
    case tokenEndpoint = "token_endpoint"
  }
}

private struct OAuthTokenResponse: Decodable {
  let accessToken: String
  let refreshToken: String?
  let expiresIn: Int

  enum CodingKeys: String, CodingKey {
    case accessToken = "access_token"
    case refreshToken = "refresh_token"
    case expiresIn = "expires_in"
  }
}

private struct OAuthTokenError: Decodable {
  let error: String
  let errorDescription: String?

  enum CodingKeys: String, CodingKey {
    case error
    case errorDescription = "error_description"
  }
}

enum OAuthError: LocalizedError {
  case authorizationFailed(String)
  case couldNotOpenBrowser
  case discoveryFailed
  case invalidResponse
  case missingCode
  case missingRefreshToken
  case reauthenticationRequired
  case signInRequired
  case stateMismatch
  case tokenRequestFailed(String)

  var errorDescription: String? {
    switch self {
    case .authorizationFailed(let error):
      "Authorization failed: \(error)"
    case .couldNotOpenBrowser:
      "Could not open the browser for sign-in."
    case .discoveryFailed:
      "Could not load the Goat authentication configuration."
    case .invalidResponse:
      "The authentication server returned an invalid response."
    case .missingCode:
      "The authentication callback did not include a code."
    case .missingRefreshToken:
      "Goat did not return a refresh token."
    case .reauthenticationRequired, .signInRequired:
      "Sign in to Goat Quick again."
    case .stateMismatch:
      "The authentication callback could not be verified."
    case .tokenRequestFailed(let message):
      "Authentication failed: \(message)"
    }
  }
}
