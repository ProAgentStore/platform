import SwiftUI

struct BoardView: View {
    @ObservedObject var store: PAGSStore
    let instance: AgentInstance

    @State private var tasks: [RuntimeTask] = []
    @State private var events: [RuntimeEvent] = []
    @State private var showAll = false
    @State private var selectedTask: RuntimeTask?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            if let errorMessage {
                ErrorBanner(message: errorMessage)
                    .padding(.horizontal)
                    .padding(.top, 8)
            }

            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(filteredTasks.count) task\(filteredTasks.count == 1 ? "" : "s")")
                        .font(.headline)
                    Text(instance.name)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Toggle("All", isOn: $showAll)
                    .toggleStyle(.button)
            }
            .padding()

            if filteredTasks.isEmpty && !isLoading {
                EmptyStateView(title: "No Tasks", systemImage: "rectangle.3.group", message: "Runtime tasks and approvals will appear here.")
            } else {
                ScrollView(.horizontal) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(TaskColumn.allCases) { column in
                            TaskColumnView(
                                column: column,
                                tasks: filteredTasks.filter { $0.column == column },
                                onSelect: { selectedTask = $0 },
                                onApprove: { task in Task { await approve(task) } },
                                onCancel: { task in Task { await cancel(task) } },
                                onResume: { task in Task { await resume(task) } }
                            )
                            .frame(width: 286)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.bottom)
                }
            }
        }
        .navigationTitle("Board")
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
        .sheet(item: $selectedTask) { task in
            TaskDetailView(
                store: store,
                instance: instance,
                task: task,
                events: events.filter { event in
                    event.references(taskID: task.id)
                },
                onChanged: {
                    Task { await load() }
                }
            )
        }
    }

    private var filteredTasks: [RuntimeTask] {
        showAll ? tasks : tasks.filter { !["completed", "cancelled"].contains($0.status) }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            async let taskResponse: TasksResponse = store.client.get("/v1/instances/\(instance.id)/tasks")
            async let eventResponse: EventsResponse = store.client.get("/v1/instances/\(instance.id)/task-events")
            tasks = try await taskResponse.tasks
            events = try await eventResponse.events
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func approve(_ task: RuntimeTask) async {
        await runAction("/v1/instances/\(instance.id)/tasks/\(task.id)/approve")
    }

    private func cancel(_ task: RuntimeTask) async {
        await runAction("/v1/instances/\(instance.id)/tasks/\(task.id)/cancel")
    }

    private func resume(_ task: RuntimeTask) async {
        await runAction("/v1/instances/\(instance.id)/takeover/\(task.id)/resume")
    }

    private func runAction(_ path: String) async {
        do {
            let _: EmptyResponse = try await store.client.post(path)
            await load()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct TaskColumnView: View {
    let column: TaskColumn
    let tasks: [RuntimeTask]
    let onSelect: (RuntimeTask) -> Void
    let onApprove: (RuntimeTask) -> Void
    let onCancel: (RuntimeTask) -> Void
    let onResume: (RuntimeTask) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Circle()
                    .fill(column.tint)
                    .frame(width: 9, height: 9)
                Text(column.title)
                    .font(.caption.bold())
                    .textCase(.uppercase)
                Spacer()
                Text("\(tasks.count)")
                    .font(.caption2.bold())
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .background(Color(.tertiarySystemGroupedBackground), in: Capsule())
            }

            ForEach(tasks) { task in
                TaskCard(task: task, onSelect: onSelect, onApprove: onApprove, onCancel: onCancel, onResume: onResume)
            }

            if tasks.isEmpty {
                Text("No tasks")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 24)
            }
        }
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
    }
}

private struct TaskCard: View {
    let task: RuntimeTask
    let onSelect: (RuntimeTask) -> Void
    let onApprove: (RuntimeTask) -> Void
    let onCancel: (RuntimeTask) -> Void
    let onResume: (RuntimeTask) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                onSelect(task)
            } label: {
                VStack(alignment: .leading, spacing: 6) {
                    Text(task.displayTitle)
                        .font(.subheadline.bold())
                        .foregroundStyle(.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let description = task.description, !description.isEmpty {
                        Text(description)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }
                    HStack {
                        StatusPill(text: task.status, tint: task.column.tint)
                        Spacer()
                        Text(relativeTime(task.createdAt))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
            .buttonStyle(.plain)

            if task.needsApproval || task.requiresHuman || task.canCancel {
                HStack {
                    if task.requiresHuman {
                        Button("Resume") { onResume(task) }
                            .buttonStyle(.borderedProminent)
                            .tint(.green)
                    } else if task.needsApproval {
                        Button("Approve") { onApprove(task) }
                            .buttonStyle(.borderedProminent)
                            .tint(.green)
                    }
                    if task.canCancel {
                        Button("Cancel") { onCancel(task) }
                            .buttonStyle(.bordered)
                            .tint(.red)
                    }
                }
                .controlSize(.small)
            }
        }
        .padding(12)
        .background(Color(.systemGroupedBackground), in: RoundedRectangle(cornerRadius: 10))
    }
}

private struct TaskDetailView: View {
    @ObservedObject var store: PAGSStore
    let instance: AgentInstance
    let task: RuntimeTask
    let events: [RuntimeEvent]
    let onChanged: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var inputValue = ""
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            List {
                if let errorMessage {
                    ErrorBanner(message: errorMessage)
                }

                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(task.displayTitle)
                            .font(.title3.bold())
                        HStack {
                            StatusPill(text: task.status, tint: task.column.tint)
                            Text(task.type)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                        }
                        if let description = task.description {
                            Text(description)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }

                if task.requiresHuman {
                    Section {
                        Text(task.handoffReason ?? "The agent is waiting for a manual step.")
                        if let field = task.handoffField {
                            Text("Field: \(field)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        TextField("Value to send to agent", text: $inputValue, axis: .vertical)
                            .lineLimit(1...4)
                        Button("Send Input") {
                            Task { await sendInput() }
                        }
                        .disabled(inputValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    } header: {
                        Text("Needs You")
                    }
                }

                if let input = task.input {
                    Section {
                        Text(input.description)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                    } header: {
                        Text("Input")
                    }
                }
                if let output = task.output {
                    Section {
                        Text(output.description)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                    } header: {
                        Text("Output")
                    }
                }
                if let result = task.result, !result.isEmpty {
                    Section {
                        Text(result)
                            .textSelection(.enabled)
                    } header: {
                        Text("Result")
                    }
                }
                if !events.isEmpty {
                    Section {
                        ForEach(events) { event in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(event.type)
                                    .font(.caption.bold())
                                if let message = event.message {
                                    Text(message)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                                Text(relativeTime(event.timestamp))
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                    } header: {
                        Text("Activity")
                    }
                }
            }
            .navigationTitle("Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { dismiss() }
                }
                if task.requiresHuman || task.needsApproval || task.canCancel {
                    ToolbarItemGroup(placement: .bottomBar) {
                        if task.requiresHuman {
                            Button("Resume") { Task { await action("takeover/\(task.id)/resume") } }
                                .tint(.green)
                        } else if task.needsApproval {
                            Button("Approve") { Task { await action("tasks/\(task.id)/approve") } }
                                .tint(.green)
                        }
                        if task.canCancel {
                            Button("Cancel") { Task { await action("tasks/\(task.id)/cancel") } }
                                .tint(.red)
                        }
                    }
                }
            }
        }
    }

    private func action(_ suffix: String) async {
        do {
            let _: EmptyResponse = try await store.client.post("/v1/instances/\(instance.id)/\(suffix)")
            onChanged()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func sendInput() async {
        do {
            let body = InputRequest(taskId: task.id, value: inputValue.trimmingCharacters(in: .whitespacesAndNewlines))
            let _: EmptyResponse = try await store.client.post("/v1/instances/\(instance.id)/input", body: body)
            inputValue = ""
            onChanged()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
