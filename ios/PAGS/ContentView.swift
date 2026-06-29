import SwiftUI

struct ContentView: View {
    @StateObject private var store = PAGSStore()
    @State private var selectedTab = 0

    var body: some View {
        Group {
            if store.isSignedIn {
                TabView(selection: $selectedTab) {
                    NavigationStack {
                        InstancesView(store: store)
                    }
                    .tabItem { Label("Agents", systemImage: "rectangle.stack") }
                    .tag(0)

                    NavigationStack {
                        if let instance = store.selectedInstance {
                            ChatView(store: store, instance: instance)
                        } else {
                            EmptyStateView(title: "No Agent", systemImage: "bubble.left.and.bubble.right", message: "Subscribe to an agent on ProAgentStore to chat here.")
                        }
                    }
                    .tabItem { Label("Chat", systemImage: "bubble.left.and.bubble.right") }
                    .tag(1)

                    NavigationStack {
                        if let instance = store.selectedInstance {
                            BoardView(store: store, instance: instance)
                        } else {
                            EmptyStateView(title: "No Board", systemImage: "rectangle.3.group", message: "Boards appear after an agent creates runtime tasks.")
                        }
                    }
                    .tabItem { Label("Board", systemImage: "rectangle.3.group") }
                    .tag(2)
                    .badge(boardBadge)

                    NavigationStack {
                        SettingsView(store: store)
                    }
                    .tabItem { Label("Settings", systemImage: "gearshape") }
                    .tag(3)
                }
                .task { await store.refresh() }
            } else {
                SetupView(store: store)
            }
        }
    }

    private var boardBadge: Int {
        0
    }
}
