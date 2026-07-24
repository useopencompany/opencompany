import XCTest

@testable import GoatQuick

final class PKCETests: XCTestCase {
  func testRFC7636ChallengeVector() {
    let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    XCTAssertEqual(PKCE.challenge(for: verifier), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  }

  func testGeneratedVerifierUsesURLSafeCharacters() throws {
    let verifier = try PKCE.generateVerifier()
    XCTAssertEqual(verifier.count, 43)
    XCTAssertNotNil(verifier.range(of: #"^[A-Za-z0-9_-]+$"#, options: .regularExpression))
  }
}
