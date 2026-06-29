import Foundation

@MainActor
final class PAGSStore: ObservableObject {
    @Published var token: String {
        didSet {
            if token.isEmpty {
                Keychain.delete("sessionToken")
            } else {
                Keychain.set(token, forKey: "sessionToken")
            }
            client.token = token
        }
    }

    @Published var user: User?
    @Published var instances: [AgentInstance] = []
    @Published var selectedInstanceID: String?
    @Published var isLoading = false
    @Published var errorMessage: String?

    let client: APIClient
    private let authSession = AuthSession()

    init() {
        let legacy = UserDefaults.standard.string(forKey: "pags.sessionToken") ?? ""
        let saved = Keychain.get("sessionToken") ?? legacy
        if !legacy.isEmpty {
            Keychain.set(legacy, forKey: "sessionToken")
            UserDefaults.standard.removeObject(forKey: "pags.sessionToken")
        }
        token = saved
        client = APIClient(token: saved)
    }

    var isSignedIn: Bool {
        !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var selectedInstance: AgentInstance? {
        guard let selectedInstanceID else { return instances.first }
        return instances.first { $0.id == selectedInstanceID }
    }

    func signOut() {
        token = ""
        user = nil
        instances = []
        selectedInstanceID = nil
    }

    func refresh() async {
        guard isSignedIn else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            async let userResponse: User = client.get("/v1/auth/me")
            async let instancesResponse: InstancesResponse = client.get("/v1/instances/my/instances")
            user = try await userResponse
            instances = try await instancesResponse.instances
            if selectedInstanceID == nil || !instances.contains(where: { $0.id == selectedInstanceID }) {
                selectedInstanceID = instances.first?.id
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func signIn(provider: AuthProvider) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let config: AuthConfig = try await client.getPublic("/v1/auth/config")
            let fasSession = try await authSession.signIn(config: config, provider: provider)
            let exchange: ExchangeResponse = try await client.postPublic("/v1/auth/exchange", body: ExchangeRequest(fasSession: fasSession))
            guard let newToken = exchange.token else {
                throw APIError.http(401, exchange.error ?? "OAuth exchange failed.")
            }
            token = newToken
            user = exchange.user
            await refresh()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
