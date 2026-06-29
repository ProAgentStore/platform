import XCTest
@testable import PAGS

final class PAGSTests: XCTestCase {
    func testTaskColumnsMatchRuntimeStatuses() {
        XCTAssertEqual(TaskColumn.column(for: "needs_approval"), .waiting)
        XCTAssertEqual(TaskColumn.column(for: "running"), .running)
        XCTAssertEqual(TaskColumn.column(for: "needs_human"), .needsHuman)
        XCTAssertEqual(TaskColumn.column(for: "failed"), .blocked)
        XCTAssertEqual(TaskColumn.column(for: "completed"), .done)
        XCTAssertEqual(TaskColumn.column(for: "cancelled"), .cancelled)
    }

    func testTaskCancelAvailabilityMatchesActiveStatuses() {
        XCTAssertTrue(task(status: "queued").canCancel)
        XCTAssertTrue(task(status: "running").canCancel)
        XCTAssertTrue(task(status: "needs_approval").canCancel)
        XCTAssertTrue(task(status: "needs_human").canCancel)
        XCTAssertTrue(task(status: "blocked").canCancel)
        XCTAssertFalse(task(status: "completed").canCancel)
        XCTAssertFalse(task(status: "cancelled").canCancel)
        XCTAssertFalse(task(status: "failed").canCancel)
    }

    func testCodingRepoSourceParserKeepsOwnerRepoSeparateFromCloneURL() {
        var source = CodingRepoSource.parse("ProAgentStore/platform")
        XCTAssertEqual(source.githubRepo, "ProAgentStore/platform")
        XCTAssertNil(source.cloneUrl)

        source = CodingRepoSource.parse("https://github.com/ProAgentStore/platform.git")
        XCTAssertNil(source.githubRepo)
        XCTAssertEqual(source.cloneUrl, "https://github.com/ProAgentStore/platform.git")

        source = CodingRepoSource.parse("git@github.com:ProAgentStore/platform.git")
        XCTAssertNil(source.githubRepo)
        XCTAssertEqual(source.cloneUrl, "git@github.com:ProAgentStore/platform.git")
    }

    func testRuntimeEventReferencesTaskByExactJSONValue() throws {
        let data = Data("""
        {
          "id": "event-1",
          "type": "task.updated",
          "message": "updated",
          "timestamp": "2026-06-29T00:00:00Z",
          "data": { "taskId": "task-123", "nested": { "other": "task-456" } }
        }
        """.utf8)
        let event = try JSONDecoder().decode(RuntimeEvent.self, from: data)
        XCTAssertTrue(event.references(taskID: "task-123"))
        XCTAssertTrue(event.references(taskID: "task-456"))
        XCTAssertFalse(event.references(taskID: "task-12"))
    }

    private func task(status: String) -> RuntimeTask {
        RuntimeTask(
            id: "task-\(status)",
            type: "test",
            status: status,
            title: nil,
            description: nil,
            result: nil,
            input: nil,
            output: nil,
            createdAt: nil,
            updatedAt: nil,
            needsHuman: nil,
            handoffReason: nil,
            handoffField: nil
        )
    }
}
