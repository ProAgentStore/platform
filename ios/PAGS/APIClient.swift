import Foundation

enum APIError: LocalizedError {
    case missingToken
    case invalidURL
    case http(Int, String)

    var errorDescription: String? {
        switch self {
        case .missingToken:
            return "PAGS token required."
        case .invalidURL:
            return "Invalid API URL."
        case .http(let code, let message):
            return message.isEmpty ? "HTTP \(code)" : message
        }
    }
}

final class APIClient {
    var token: String
    var baseURL: URL

    init(token: String, baseURL: URL = URL(string: "https://api.proagentstore.online")!) {
        self.token = token
        self.baseURL = baseURL
    }

    func get<T: Decodable>(_ path: String) async throws -> T {
        try await request(path, method: "GET")
    }

    func getPublic<T: Decodable>(_ path: String) async throws -> T {
        try await request(path, method: "GET", noAuth: true)
    }

    func post<T: Decodable>(_ path: String, body: Encodable? = nil) async throws -> T {
        try await request(path, method: "POST", body: body)
    }

    func postPublic<T: Decodable>(_ path: String, body: Encodable? = nil) async throws -> T {
        try await request(path, method: "POST", body: body, noAuth: true)
    }

    func put<T: Decodable>(_ path: String, body: Encodable? = nil) async throws -> T {
        try await request(path, method: "PUT", body: body)
    }

    func delete<T: Decodable>(_ path: String) async throws -> T {
        try await request(path, method: "DELETE")
    }

    private func request<T: Decodable>(_ path: String, method: String, body: Encodable? = nil, noAuth: Bool = false) async throws -> T {
        guard noAuth || !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw APIError.missingToken
        }
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw APIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        if !noAuth {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let payload = (try? JSONDecoder().decode(ErrorPayload.self, from: data))?.error
            throw APIError.http(status, payload ?? String(data: data, encoding: .utf8) ?? "")
        }
        if data.isEmpty {
            if let empty = EmptyResponse() as? T {
                return empty
            }
            throw APIError.http(status, "Empty response.")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

private struct ErrorPayload: Decodable {
    let error: String?
}

private struct AnyEncodable: Encodable {
    private let encodeBody: (Encoder) throws -> Void

    init(_ value: Encodable) {
        encodeBody = value.encode
    }

    func encode(to encoder: Encoder) throws {
        try encodeBody(encoder)
    }
}

struct ChatRequest: Encodable {
    let message: String
}

struct AuthConfig: Decodable {
    let oauthURL: String
    let googleOAuthURL: String
    let appID: String
    let responseMode: String

    enum CodingKeys: String, CodingKey {
        case oauthURL = "oauth_url"
        case googleOAuthURL = "google_oauth_url"
        case appID = "app_id"
        case responseMode = "response_mode"
    }
}

struct ExchangeRequest: Encodable {
    let fasSession: String

    enum CodingKeys: String, CodingKey {
        case fasSession = "fas_session"
    }
}

struct ExchangeResponse: Decodable {
    let token: String?
    let user: User?
    let error: String?
}

struct InstructionsRequest: Encodable {
    let instructions: String
}

struct InputRequest: Encodable {
    let taskId: String
    let value: String
}
