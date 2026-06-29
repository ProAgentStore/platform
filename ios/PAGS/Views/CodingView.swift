import SwiftUI

struct CodingView: View {
    @ObservedObject var store: PAGSStore
    let instance: AgentInstance

    @State private var repos: [CodingRepo] = []
    @State private var sessions: [CodingSession] = []
    @State private var selectedSession: CodingSession?
    @State private var repoName = ""
    @State private var localPath = ""
    @State private var githubRepo = ""
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        List {
            if let errorMessage {
                ErrorBanner(message: errorMessage)
            }

            Section {
                TextField("Name", text: $repoName)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("~/dev/project or /Users/you/dev/project", text: $localPath)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                TextField("owner/repo or clone URL", text: $githubRepo)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button {
                    Task { await addRepo() }
                } label: {
                    Label("Add Repo", systemImage: "plus")
                }
            } header: {
                Text("Add Repository")
            } footer: {
                Text("Local paths work best when `pags up` runs on the same machine.")
            }

            Section {
                if repos.isEmpty {
                    Text("No repos yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(repos) { repo in
                    RepoRow(
                        repo: repo,
                        activeSession: sessions.first { $0.repoId == repo.id && $0.status == "active" },
                        onStart: { Task { await start(repo) } },
                        onOpen: { session in selectedSession = session }
                    )
                }
            } header: {
                Text("Repositories")
            }

            if !sessions.isEmpty {
                Section {
                    ForEach(sessions) { session in
                        Button {
                            selectedSession = session
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(repoName(for: session))
                                        .foregroundStyle(.primary)
                                    Text(session.clientType ?? "coding")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                StatusPill(text: session.status, tint: session.status == "active" ? .green : .gray)
                            }
                        }
                    }
                } header: {
                    Text("Sessions")
                }
            }
        }
        .navigationTitle("Coding")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await load() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(isLoading)
            }
        }
        .task { await load() }
        .sheet(item: $selectedSession) { session in
            CodingSessionView(store: store, instance: instance, session: session, repoName: repoName(for: session))
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let repoResponse: CodingReposResponse = store.client.get("/v1/instances/\(instance.id)/coding/repos")
            async let sessionResponse: CodingSessionsResponse = store.client.get("/v1/instances/\(instance.id)/coding/sessions")
            repos = try await repoResponse.repos
            sessions = try await sessionResponse.sessions
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func addRepo() async {
        let cleanName = repoName.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanPath = localPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanGithub = githubRepo.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty || !cleanPath.isEmpty || !cleanGithub.isEmpty else { return }
        do {
            let source = CodingRepoSource.parse(cleanGithub)
            let body = AddCodingRepoRequest(
                name: cleanName.isEmpty ? nil : cleanName,
                localPath: cleanPath.isEmpty ? nil : cleanPath,
                githubRepo: source.githubRepo,
                cloneUrl: source.cloneUrl,
                defaultClient: nil
            )
            let _: AddRepoResponse = try await store.client.post("/v1/instances/\(instance.id)/coding/repos", body: body)
            repoName = ""
            localPath = ""
            githubRepo = ""
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func start(_ repo: CodingRepo) async {
        do {
            let response: CodingSessionResponse = try await store.client.post(
                "/v1/instances/\(instance.id)/coding/sessions",
                body: StartCodingSessionRequest(repoId: repo.id, engineId: nil)
            )
            await load()
            selectedSession = response.session
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func repoName(for session: CodingSession) -> String {
        repos.first { $0.id == session.repoId }?.name ?? session.repoId
    }
}

private struct AddRepoResponse: Decodable {
    let repo: CodingRepo
}

private struct RepoRow: View {
    let repo: CodingRepo
    let activeSession: CodingSession?
    let onStart: () -> Void
    let onOpen: (CodingSession) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(repo.name)
                        .font(.headline)
                    Text(repo.workdir ?? repo.githubRepo ?? repo.cloneUrl ?? "No source")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                StatusPill(text: repo.cloneStatus ?? "ready", tint: repo.cloneStatus == "error" ? .red : .green)
            }

            HStack {
                if let activeSession {
                    Button("Open Session") { onOpen(activeSession) }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                    StatusPill(text: activeSession.status, tint: .green)
                } else {
                    Button("Start Session", action: onStart)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

private struct CodingSessionView: View {
    @ObservedObject var store: PAGSStore
    let instance: AgentInstance
    let session: CodingSession
    let repoName: String

    @Environment(\.dismiss) private var dismiss
    @State private var pane = ""
    @State private var selectedPanel: CodingSessionPanel = .summary
    @State private var cliRunState = "idle"
    @State private var timeline: [CodingTimelineEntry] = []
    @State private var message = ""
    @State private var isSending = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if let errorMessage {
                    ErrorBanner(message: errorMessage)
                        .padding()
                }

                Picker("View", selection: $selectedPanel) {
                    ForEach(CodingSessionPanel.allCases) { panel in
                        Text(panel.title).tag(panel)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.top)

                if selectedPanel == .terminal {
                    ScrollView {
                        Text(pane.isEmpty ? "(waiting for terminal)" : pane)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding()
                    }
                    .background(Color(.secondarySystemGroupedBackground))
                } else {
                    List {
                        if timeline.isEmpty {
                            Text("No session messages yet.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(timeline) { entry in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(entry.displayRole)
                                    .font(.caption.bold())
                                    .foregroundStyle(.secondary)
                                Text(entry.displayText)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                }

                Divider()
                HStack(alignment: .bottom) {
                    TextField("Ask or tell the coding agent...", text: $message, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(1...4)
                    Button {
                        Task { await send() }
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title2)
                    }
                    .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)
                }
                .padding()
            }
            .navigationTitle(repoName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .principal) {
                    StatusPill(text: cliRunState, tint: cliRunState == "idle" ? .gray : .blue)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await refresh() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
        }
        .task { await refresh() }
    }

    private func refresh() async {
        do {
            async let capture: CodingCaptureResponse = store.client.get("/v1/instances/\(instance.id)/coding/sessions/\(session.id)/capture")
            async let history: CodingTimelineResponse = store.client.get("/v1/instances/\(instance.id)/coding/sessions/\(session.id)/timeline")
            let captureValue = try await capture
            pane = captureValue.pane ?? ""
            cliRunState = captureValue.runState ?? "idle"
            timeline = try await history.chat ?? []
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func send() async {
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        message = ""
        isSending = true
        defer { isSending = false }
        do {
            let response: CodingAgentResponse = try await store.client.post(
                "/v1/instances/\(instance.id)/coding/sessions/\(session.id)/agent",
                body: CodingMessageRequest(message: text)
            )
            if let reply = response.reply ?? response.response {
                timeline.append(CodingTimelineEntry(role: "assistant", type: nil, content: reply, text: nil, seq: nil))
            } else if let error = response.error {
                errorMessage = error
            }
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
