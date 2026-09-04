import type { OAuthClientMetadata, OAuthClientProvider } from "@ai-sdk/mcp";

type AuthorizationRequired = () => never | Promise<never>;

// Adapts a token refreshed by the provider's own connection plane to the MCP
// transport. The MCP SDK only sees the current access token; it can neither
// persist a replacement nor start its DCR/OAuth flow after a 401.
export function createRemoteMcpStaticBearerAuthProvider(input: {
  accessToken: string;
  onAuthorizationRequired: AuthorizationRequired;
}): OAuthClientProvider {
  const authorizationRequired = async (): Promise<never> => await input.onAuthorizationRequired();

  return {
    tokens: () => ({ access_token: input.accessToken, token_type: "Bearer" }),
    saveTokens: authorizationRequired,
    redirectToAuthorization: authorizationRequired,
    saveCodeVerifier: authorizationRequired,
    codeVerifier: authorizationRequired,
    redirectUrl: "urn:ietf:wg:oauth:2.0:oob",
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: "opencompany static bearer",
        redirect_uris: ["urn:ietf:wg:oauth:2.0:oob"],
      };
    },
    clientInformation: () => ({ client_id: "opencompany-static-bearer" }),
    saveClientInformation: authorizationRequired,
    invalidateCredentials: authorizationRequired,
    // The SDK invokes auth() after a 401. Stop that path before it attempts
    // authorization-server discovery or dynamic client registration.
    validateResourceURL: async () => await authorizationRequired(),
    validateAuthorizationServerURL: authorizationRequired,
  };
}
