import Foundation
import XCTest

@testable import GoatQuick

@MainActor
final class OAuthClientTests: XCTestCase {
  func testAuthorizationURLContainsPKCEAndState() throws {
    let url = try OAuthClient.authorizationURL(
      endpoint: URL(string: "https://auth.example/authorize")!,
      clientID: "client_123",
      redirectURI: URL(string: "http://127.0.0.1:49152/oauth/callback")!,
      verifier: "verifier",
      state: "state-value",
      nonce: "nonce-value"
    )
    let items = Dictionary(
      uniqueKeysWithValues: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
        .map { ($0.name, $0.value ?? "") }
    )
    XCTAssertEqual(items["client_id"], "client_123")
    XCTAssertEqual(items["redirect_uri"], "http://127.0.0.1:49152/oauth/callback")
    XCTAssertEqual(items["scope"], "openid profile email offline_access")
    XCTAssertEqual(items["code_challenge_method"], "S256")
    XCTAssertEqual(items["code_challenge"], PKCE.challenge(for: "verifier"))
    XCTAssertEqual(items["state"], "state-value")
    XCTAssertEqual(items["nonce"], "nonce-value")
  }

  func testCallbackStateMustMatchBeforeUsingTheCode() throws {
    XCTAssertThrowsError(
      try OAuthClient.authorizationCode(
        from: OAuthCallback(code: "code", state: "unexpected", error: nil),
        expectedState: "expected"
      )
    ) { error in
      guard case OAuthError.stateMismatch = error else {
        return XCTFail("Expected stateMismatch, got \(error)")
      }
    }
    XCTAssertEqual(
      try OAuthClient.authorizationCode(
        from: OAuthCallback(code: "code", state: "expected", error: nil),
        expectedState: "expected"
      ),
      "code"
    )
  }

  func testRefreshTokenRotationIsSavedAtomically() async throws {
    let store = MemoryTokenStore(token: "refresh-old")
    let client = try OAuthClient(
      configuration: configuration,
      tokenStore: store,
      requestPerformer: { request in
        if request.url?.path == "/.well-known/oauth-authorization-server" {
          return Self.response(
            request,
            json: [
              "authorization_endpoint": "https://auth.example/authorize",
              "token_endpoint": "https://auth.example/token",
            ])
        }
        XCTAssertEqual(request.url?.path, "/token")
        let body = String(data: request.httpBody ?? Data(), encoding: .utf8) ?? ""
        XCTAssertTrue(body.contains("refresh_token=refresh-old"))
        return Self.response(
          request,
          json: [
            "access_token": "access-new",
            "refresh_token": "refresh-new",
            "expires_in": 3600,
          ])
      }
    )

    let accessToken = try await client.accessToken(forceRefresh: true)
    XCTAssertEqual(accessToken, "access-new")
    XCTAssertEqual(store.token, "refresh-new")
    XCTAssertEqual(store.savedTokens, ["refresh-new"])
    XCTAssertTrue(client.isSignedIn)
  }

  func testInvalidGrantClearsCredentials() async throws {
    let store = MemoryTokenStore(token: "revoked")
    let client = try OAuthClient(
      configuration: configuration,
      tokenStore: store,
      requestPerformer: { request in
        if request.url?.path == "/.well-known/oauth-authorization-server" {
          return Self.response(
            request,
            json: [
              "authorization_endpoint": "https://auth.example/authorize",
              "token_endpoint": "https://auth.example/token",
            ])
        }
        return Self.response(
          request,
          status: 400,
          json: ["error": "invalid_grant", "error_description": "Expired"]
        )
      }
    )

    await assertThrowsErrorAsync { try await client.accessToken(forceRefresh: true) }
    XCTAssertNil(store.token)
    XCTAssertFalse(client.isSignedIn)
  }

  private var configuration: GoatQuickConfiguration {
    GoatQuickConfiguration(
      apiBaseURL: URL(string: "https://goat.example")!,
      oauthIssuer: URL(string: "https://auth.example")!,
      oauthClientID: "client_123"
    )
  }

  private static func response(
    _ request: URLRequest,
    status: Int = 200,
    json: [String: Any]
  ) -> (Data, URLResponse) {
    let response = HTTPURLResponse(
      url: request.url!,
      statusCode: status,
      httpVersion: nil,
      headerFields: ["Content-Type": "application/json"]
    )!
    return (try! JSONSerialization.data(withJSONObject: json), response)
  }
}

private final class MemoryTokenStore: RefreshTokenStore {
  var token: String?
  var savedTokens = [String]()

  init(token: String?) { self.token = token }
  func load() throws -> String? { token }
  func save(_ token: String) throws {
    self.token = token
    savedTokens.append(token)
  }
  func clear() throws { token = nil }
}

@MainActor
private func assertThrowsErrorAsync<T: Sendable>(
  _ expression: @MainActor () async throws -> T,
  file: StaticString = #filePath,
  line: UInt = #line
) async {
  do {
    _ = try await expression()
    XCTFail("Expected expression to throw", file: file, line: line)
  } catch {}
}
