import SwiftUI

struct EmptyStateView: View {
    let title: String
    let systemImage: String
    let message: String

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(message)
        }
    }
}

struct StatusPill: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text.replacingOccurrences(of: "_", with: " ").uppercased())
            .font(.caption2.bold())
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .foregroundStyle(tint)
            .background(tint.opacity(0.12), in: Capsule())
    }
}

struct SurfacePill: View {
    let surface: String

    var body: some View {
        Label(surface.capitalized, systemImage: icon)
            .font(.caption.bold())
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Color(.secondarySystemGroupedBackground), in: Capsule())
    }

    private var icon: String {
        switch surface {
        case "coding": return "terminal"
        case "apply": return "paperplane"
        case "insurance": return "shield"
        default: return "square.grid.2x2"
        }
    }
}

struct ErrorBanner: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote)
            .foregroundStyle(.red)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
    }
}

func relativeTime(_ iso: String?) -> String {
    guard let iso else { return "" }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let fallback = ISO8601DateFormatter()
    let date = formatter.date(from: iso) ?? fallback.date(from: iso)
    guard let date else { return "" }
    return date.formatted(.relative(presentation: .named))
}
