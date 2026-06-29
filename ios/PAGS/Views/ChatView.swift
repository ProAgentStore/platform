import SwiftUI

struct ChatView: View {
    @ObservedObject var store: PAGSStore
    let instance: AgentInstance

    @State private var messages: [AgentMessage] = []
    @State private var draft = ""
    @State private var isLoading = false
    @State private var isSending = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            if let errorMessage {
                ErrorBanner(message: errorMessage)
                    .padding(.horizontal)
                    .padding(.top, 8)
            }

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(messages) { message in
                            MessageBubble(message: message)
                                .id(message.id)
                        }
                        if isSending {
                            HStack {
                                ProgressView()
                                    .controlSize(.small)
                                Text("Thinking...")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                Spacer()
                            }
                            .padding(.horizontal)
                        }
                    }
                    .padding()
                }
                .onChange(of: messages.count) { _, _ in
                    if let last = messages.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }

            Divider()
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Send a message...", text: $draft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...4)
                    .disabled(isSending)

                Button {
                    Task { await send() }
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)
            }
            .padding()
        }
        .navigationTitle(instance.name)
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
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let response: MessagesResponse = try await store.client.get("/v1/instances/\(instance.id)/messages?limit=200")
            messages = response.messages
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func send() async {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        let localMessage = AgentMessage(role: "user", content: text)
        messages.append(localMessage)
        isSending = true
        defer { isSending = false }
        do {
            let response: ChatResponse = try await store.client.post("/v1/instances/\(instance.id)/chat", body: ChatRequest(message: text))
            if let toolMessage = response.toolMessage {
                messages.append(toolMessage)
            }
            if let message = response.message {
                messages.append(message)
            } else if let error = response.error {
                errorMessage = error
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct MessageBubble: View {
    let message: AgentMessage

    var body: some View {
        HStack {
            if message.role == "user" { Spacer(minLength: 48) }
            VStack(alignment: message.role == "user" ? .trailing : .leading, spacing: 4) {
                Text(label)
                    .font(.caption2.bold())
                    .foregroundStyle(.secondary)
                Text(message.content)
                    .font(.body)
                    .textSelection(.enabled)
                if !relativeTime(message.createdAt).isEmpty {
                    Text(relativeTime(message.createdAt))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(background, in: RoundedRectangle(cornerRadius: 14))
            if message.role != "user" { Spacer(minLength: 48) }
        }
    }

    private var label: String {
        switch message.role {
        case "user": return "You"
        case "system": return "System"
        default: return "Agent"
        }
    }

    private var background: Color {
        switch message.role {
        case "user": return .purple.opacity(0.16)
        case "system": return .yellow.opacity(0.14)
        default: return Color(.secondarySystemGroupedBackground)
        }
    }
}
