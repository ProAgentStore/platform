import SwiftUI

struct InstancesView: View {
    @ObservedObject var store: PAGSStore

    var body: some View {
        List(selection: $store.selectedInstanceID) {
            if let error = store.errorMessage {
                ErrorBanner(message: error)
                    .listRowBackground(Color.clear)
            }

            ForEach(store.instances) { instance in
                NavigationLink(value: instance) {
                    InstanceRow(instance: instance, selected: store.selectedInstanceID == instance.id)
                }
                .simultaneousGesture(TapGesture().onEnded {
                    store.selectedInstanceID = instance.id
                })
            }
        }
        .navigationTitle("Agents")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await store.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(store.isLoading)
            }
        }
        .refreshable { await store.refresh() }
        .navigationDestination(for: AgentInstance.self) { instance in
            InstanceHomeView(store: store, instance: instance)
                .onAppear { store.selectedInstanceID = instance.id }
        }
        .overlay {
            if store.instances.isEmpty && !store.isLoading {
                EmptyStateView(title: "No Agents", systemImage: "rectangle.stack.badge.plus", message: "Subscribe to agents on ProAgentStore, then refresh.")
            }
        }
    }
}

private struct InstanceRow: View {
    let instance: AgentInstance
    let selected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(instance.name)
                        .font(.headline)
                    Text(instance.slug)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if selected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.purple)
                }
            }
            if let description = instance.description, !description.isEmpty {
                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            HStack {
                StatusPill(text: instance.status, tint: instance.status == "active" ? .green : .gray)
                ForEach(instance.surfaces, id: \.self) { surface in
                    SurfacePill(surface: surface)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

private struct InstanceHomeView: View {
    @ObservedObject var store: PAGSStore
    let instance: AgentInstance

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text(instance.name)
                        .font(.title2.bold())
                    if let description = instance.description {
                        Text(description)
                            .foregroundStyle(.secondary)
                    }
                    HStack {
                        StatusPill(text: instance.status, tint: .green)
                        ForEach(instance.surfaces, id: \.self) { SurfacePill(surface: $0) }
                    }
                }
                .padding(.vertical, 6)
            }

            Section {
                NavigationLink {
                    ChatView(store: store, instance: instance)
                } label: {
                    Label("Chat", systemImage: "bubble.left.and.bubble.right")
                }
                NavigationLink {
                    BoardView(store: store, instance: instance)
                } label: {
                    Label("Kanban Board", systemImage: "rectangle.3.group")
                }
                if instance.surfaces.contains("coding") {
                    NavigationLink {
                        CodingView(store: store, instance: instance)
                    } label: {
                        Label("Coding", systemImage: "terminal")
                    }
                }
                NavigationLink {
                    InstanceSettingsView(store: store, instance: instance)
                } label: {
                    Label("Agent Settings", systemImage: "slider.horizontal.3")
                }
            } header: {
                Text("Native Surfaces")
            }
        }
        .navigationTitle(instance.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}
