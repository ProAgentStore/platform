import SwiftUI

struct SetupView: View {
    @ObservedObject var store: PAGSStore
    @State private var token = ""
    @State private var isChecking = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Image(systemName: "bolt.fill")
                            .font(.largeTitle)
                            .foregroundStyle(.purple)
                        Text("ProAgentStore")
                            .font(.largeTitle.bold())
                        Text("Native operations for your PAGS agents. Chat, task boards, approvals, and settings are rendered directly in SwiftUI.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 12)
                }

                Section {
                    Button {
                        Task { await store.signIn(provider: .github) }
                    } label: {
                        Label("Continue with GitHub", systemImage: "person.crop.circle.badge.checkmark")
                    }
                    .disabled(store.isLoading)

                    Button {
                        Task { await store.signIn(provider: .google) }
                    } label: {
                        Label("Continue with Google", systemImage: "g.circle")
                    }
                    .disabled(store.isLoading)
                } header: {
                    Text("Sign In")
                } footer: {
                    Text("Uses the system authentication session and returns to the app with a pags:// callback. No web UI is embedded inside PAGS.")
                }

                Section {
                    SecureField("PAGS token", text: $token)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Button {
                        Task { await signIn() }
                    } label: {
                        if isChecking {
                            ProgressView()
                        } else {
                            Label("Connect", systemImage: "checkmark.circle")
                        }
                    }
                    .disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isChecking)
                } header: {
                    Text("Manual Session Token")
                } footer: {
                    Text("Fallback for local testing. Paste the same PAGS session token used by the console.")
                }

                if let error = store.errorMessage {
                    Section {
                        ErrorBanner(message: error)
                    }
                }
            }
            .navigationTitle("Setup")
        }
    }

    private func signIn() async {
        isChecking = true
        store.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        await store.refresh()
        if store.user == nil {
            store.signOut()
        }
        isChecking = false
    }
}
