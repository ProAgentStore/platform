import SwiftUI

struct SettingsView: View {
    @ObservedObject var store: PAGSStore

    var body: some View {
        List {
            Section {
                if let user = store.user {
                    HStack {
                        Image(systemName: "person.crop.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.purple)
                        VStack(alignment: .leading) {
                            Text(user.login)
                                .font(.headline)
                            if let roles = user.roles {
                                Text(roles.joined(separator: ", "))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                } else {
                    Text("Connected with local session token")
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("Account")
            }

            Section {
                Picker("Agent", selection: $store.selectedInstanceID) {
                    ForEach(store.instances) { instance in
                        Text(instance.name).tag(Optional(instance.id))
                    }
                }
                if let instance = store.selectedInstance {
                    NavigationLink {
                        InstanceSettingsView(store: store, instance: instance)
                    } label: {
                        Label("Agent Settings", systemImage: "slider.horizontal.3")
                    }
                }
            } header: {
                Text("Selected Agent")
            }

            Section {
                Label("Chat", systemImage: "bubble.left.and.bubble.right")
                Label("Kanban board", systemImage: "rectangle.3.group")
                Label("Approvals and input handoff", systemImage: "checkmark.circle")
                Label("Special instructions", systemImage: "text.badge.checkmark")
            } header: {
                Text("Native Scope")
            } footer: {
                Text("This app does not embed web UI. Unknown custom agent surfaces fall back to native chat, board, and settings.")
            }

            Section {
                Button(role: .destructive) {
                    store.signOut()
                } label: {
                    Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        }
        .navigationTitle("Settings")
        .task { await store.refresh() }
    }
}

struct InstanceSettingsView: View {
    @ObservedObject var store: PAGSStore
    let instance: AgentInstance

    @State private var instructions = ""
    @State private var isLoading = false
    @State private var isSaving = false
    @State private var message: String?
    @State private var errorMessage: String?

    var body: some View {
        Form {
            if let errorMessage {
                Section {
                    ErrorBanner(message: errorMessage)
                }
            }
            if let message {
                Section {
                    Label(message, systemImage: "checkmark.circle")
                        .foregroundStyle(.green)
                }
            }

            Section {
                LabeledContent("Name", value: instance.name)
                LabeledContent("Slug", value: instance.slug)
                LabeledContent("Status", value: instance.status)
                if !instance.surfaces.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Surfaces")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        HStack {
                            ForEach(instance.surfaces, id: \.self) { SurfacePill(surface: $0) }
                        }
                    }
                }
            } header: {
                Text("Agent")
            }

            Section {
                TextField("Rules this agent should follow", text: $instructions, axis: .vertical)
                    .lineLimit(5...12)
                Button {
                    Task { await saveInstructions() }
                } label: {
                    if isSaving {
                        ProgressView()
                    } else {
                        Label("Save Instructions", systemImage: "square.and.arrow.down")
                    }
                }
                .disabled(isSaving)
            } header: {
                Text("Special Instructions")
            } footer: {
                Text("These are stored on your private instance and used by workflows such as job application automation.")
            }

            Section {
                Button {
                    Task { await clearFinishedTasks() }
                } label: {
                    Label("Clear Finished Board Tasks", systemImage: "checklist.unchecked")
                }
                Button(role: .destructive) {
                    Task { await unsubscribe() }
                } label: {
                    Label("Unsubscribe", systemImage: "trash")
                }
            } header: {
                Text("Maintenance")
            }
        }
        .navigationTitle(instance.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await loadInstructions() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(isLoading)
            }
        }
        .task { await loadInstructions() }
    }

    private func loadInstructions() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response: InstructionsResponse = try await store.client.get("/v1/instances/\(instance.id)/instructions")
            instructions = response.instructions
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func saveInstructions() async {
        isSaving = true
        defer { isSaving = false }
        do {
            let _: EmptyResponse = try await store.client.put("/v1/instances/\(instance.id)/instructions", body: InstructionsRequest(instructions: instructions))
            message = "Instructions saved"
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func clearFinishedTasks() async {
        do {
            let _: EmptyResponse = try await store.client.post("/v1/instances/\(instance.id)/tasks/clear-finished")
            message = "Finished tasks cleared"
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func unsubscribe() async {
        do {
            let _: EmptyResponse = try await store.client.post("/v1/instances/\(instance.id)/cancel")
            await store.refresh()
            message = "Unsubscribed"
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
