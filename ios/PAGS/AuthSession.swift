import AuthenticationServices
import Foundation
import UIKit

@MainActor
final class AuthSession: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func signIn(config: AuthConfig, provider: AuthProvider) async throws -> String {
        let start = provider == .github ? config.oauthURL : config.googleOAuthURL
        guard var components = URLComponents(string: start) else {
            throw APIError.invalidURL
        }
        components.queryItems = (components.queryItems ?? []) + [
            URLQueryItem(name: "app_id", value: config.appID),
            URLQueryItem(name: "response_mode", value: config.responseMode),
            URLQueryItem(name: "return_to", value: "pags://auth"),
        ]
        guard let url = components.url else {
            throw APIError.invalidURL
        }

        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "pags") { callbackURL, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                guard
                    let callbackURL,
                    let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                    let fasSession = components.queryItems?.first(where: { $0.name == "fas_session" })?.value,
                    !fasSession.isEmpty
                else {
                    continuation.resume(throwing: APIError.http(400, "OAuth callback did not include a FAS session."))
                    return
                }
                continuation.resume(returning: fasSession)
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                continuation.resume(throwing: APIError.http(500, "Could not start OAuth session."))
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}

enum AuthProvider {
    case github
    case google
}
