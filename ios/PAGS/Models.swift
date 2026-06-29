import Foundation
import SwiftUI

struct User: Decodable, Identifiable {
    let id: String
    let login: String
    let avatar: String?
    let roles: [String]?
}

struct InstancesResponse: Decodable {
    let instances: [AgentInstance]
}

struct AgentInstance: Decodable, Identifiable, Hashable {
    let id: String
    let agentId: String
    let slug: String
    let name: String
    let description: String?
    let icon: String?
    let iconBg: String?
    let category: String?
    let status: String
    let createdAt: String?
    let capabilities: AgentCapabilities?

    enum CodingKeys: String, CodingKey {
        case id
        case agentId = "agent_id"
        case slug
        case name
        case description
        case icon
        case iconBg = "icon_bg"
        case category
        case status
        case createdAt = "created_at"
        case capabilities
    }

    var surfaces: [String] { capabilities?.surfaces ?? [] }
}

struct AgentCapabilities: Decodable, Hashable {
    let surfaces: [String]
    let runtime: String?
    let workflow: String?
}

struct MessagesResponse: Decodable {
    let messages: [AgentMessage]
}

struct ChatResponse: Decodable {
    let message: AgentMessage?
    let toolMessage: AgentMessage?
    let error: String?
}

struct AgentMessage: Decodable, Identifiable, Hashable {
    let id: String
    let role: String
    let content: String
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id
        case role
        case content
        case createdAt
    }

    init(id: String = UUID().uuidString, role: String, content: String, createdAt: String? = nil) {
        self.id = id
        self.role = role
        self.content = content
        self.createdAt = createdAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        role = try container.decode(String.self, forKey: .role)
        content = try container.decode(String.self, forKey: .content)
        createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
    }
}

struct TasksResponse: Decodable {
    let tasks: [RuntimeTask]
}

struct EventsResponse: Decodable {
    let events: [RuntimeEvent]
}

struct RuntimeTask: Decodable, Identifiable, Hashable {
    let id: String
    let type: String
    let status: String
    let title: String?
    let description: String?
    let result: String?
    let input: JSONValue?
    let output: JSONValue?
    let createdAt: String?
    let updatedAt: String?
    let needsHuman: Bool?
    let handoffReason: String?
    let handoffField: String?

    enum CodingKeys: String, CodingKey {
        case id
        case type
        case status
        case title
        case description
        case result
        case input
        case output
        case createdAt
        case updatedAt
        case needsHuman = "needs_human"
        case handoffReason = "handoff_reason"
        case handoffField = "handoff_field"
    }

    var displayTitle: String { title?.isEmpty == false ? title! : type }
    var column: TaskColumn { TaskColumn.column(for: status) }
    var needsApproval: Bool { status == "needs_approval" }
    var requiresHuman: Bool { status == "needs_human" || needsHuman == true }
    var canCancel: Bool { ["queued", "running", "needs_approval", "needs_human", "blocked"].contains(status) }
}

struct RuntimeEvent: Decodable, Identifiable, Hashable {
    let id: String
    let type: String
    let message: String?
    let timestamp: String
    let data: JSONValue?

    func references(taskID: String) -> Bool {
        data?.containsExactString(taskID) == true
    }
}

struct InstructionsResponse: Decodable {
    let instructions: String
}

struct EmptyResponse: Decodable {}

struct CodingReposResponse: Decodable {
    let repos: [CodingRepo]
}

struct CodingSessionsResponse: Decodable {
    let sessions: [CodingSession]
}

struct CodingSessionResponse: Decodable {
    let session: CodingSession
    let runnerConnected: Bool?
    let reused: Bool?
}

struct CodingRepo: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let githubRepo: String?
    let cloneUrl: String?
    let branch: String?
    let workdir: String?
    let cloneStatus: String?
    let defaultClient: String?
    let instructions: String?
    let createdAt: String?
    let updatedAt: String?
}

struct CodingSession: Decodable, Identifiable, Hashable {
    let id: String
    let repoId: String
    let clientType: String?
    let status: String
    let launchCommand: String?
    let startedAt: String?
    let endedAt: String?
    let updatedAt: String?
}

struct CodingCaptureResponse: Decodable {
    let pane: String?
    let runState: String?
    let alive: Bool?
    let ready: Bool?
    let runnerConnected: Bool?
}

struct CodingTimelineResponse: Decodable {
    let chat: [CodingTimelineEntry]?
}

struct CodingTimelineEntry: Decodable, Identifiable, Hashable {
    let id = UUID().uuidString
    let role: String?
    let type: String?
    let content: String?
    let text: String?
    let seq: Int?

    enum CodingKeys: CodingKey {
        case role
        case type
        case content
        case text
        case seq
    }

    var displayRole: String { role ?? type ?? "event" }
    var displayText: String { content ?? text ?? "" }
}

struct CodingAgentResponse: Decodable {
    let delegated: Bool?
    let reply: String?
    let response: String?
    let error: String?
}

struct AddCodingRepoRequest: Encodable {
    let name: String?
    let localPath: String?
    let githubRepo: String?
    let cloneUrl: String?
    let defaultClient: String?
}

struct CodingRepoSource {
    let githubRepo: String?
    let cloneUrl: String?

    static func parse(_ raw: String) -> CodingRepoSource {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            return CodingRepoSource(githubRepo: nil, cloneUrl: nil)
        }
        if value.contains("://") || value.hasPrefix("git@") || value.hasSuffix(".git") {
            return CodingRepoSource(githubRepo: nil, cloneUrl: value)
        }
        if value.split(separator: "/").count == 2 {
            return CodingRepoSource(githubRepo: value, cloneUrl: nil)
        }
        return CodingRepoSource(githubRepo: nil, cloneUrl: value)
    }
}

struct StartCodingSessionRequest: Encodable {
    let repoId: String
    let engineId: String?
}

struct CodingMessageRequest: Encodable {
    let message: String
}

enum CodingSessionPanel: String, CaseIterable, Identifiable {
    case summary
    case terminal

    var id: String { rawValue }
    var title: String { self == .summary ? "Summary" : "Terminal" }
}

enum TaskColumn: String, CaseIterable, Identifiable {
    case waiting
    case running
    case needsHuman
    case blocked
    case done
    case cancelled

    var id: String { rawValue }

    var title: String {
        switch self {
        case .waiting: return "Waiting"
        case .running: return "Running"
        case .needsHuman: return "Needs You"
        case .blocked: return "Blocked"
        case .done: return "Done"
        case .cancelled: return "Cancelled"
        }
    }

    var tint: Color {
        switch self {
        case .waiting: return .yellow
        case .running: return .blue
        case .needsHuman: return .orange
        case .blocked: return .red
        case .done: return .green
        case .cancelled: return .gray
        }
    }

    static func column(for status: String) -> TaskColumn {
        switch status {
        case "queued", "needs_approval": return .waiting
        case "running": return .running
        case "needs_human": return .needsHuman
        case "blocked", "failed", "expired": return .blocked
        case "completed": return .done
        case "cancelled": return .cancelled
        default: return .blocked
        }
    }
}

enum JSONValue: Decodable, Hashable, CustomStringConvertible {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    var description: String {
        switch self {
        case .string(let value): return value
        case .number(let value):
            return value.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(value)) : String(value)
        case .bool(let value): return value ? "true" : "false"
        case .null: return "null"
        case .array(let values):
            return "[" + values.map(\.description).joined(separator: ", ") + "]"
        case .object(let values):
            let body = values.keys.sorted().map { key in
                "\(key): \(values[key]?.description ?? "null")"
            }.joined(separator: "\n")
            return body
        }
    }

    func containsExactString(_ needle: String) -> Bool {
        switch self {
        case .string(let value):
            return value == needle
        case .number, .bool, .null:
            return false
        case .array(let values):
            return values.contains { $0.containsExactString(needle) }
        case .object(let values):
            return values.contains { key, value in
                key == needle || value.containsExactString(needle)
            }
        }
    }
}
