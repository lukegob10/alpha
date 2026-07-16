import attemptCompletion from "../tools/native-tools/attempt_completion"
import updateTodoList from "../tools/native-tools/update_todo_list"
import { markdownFormattingSection } from "../sections/markdown-formatting"

describe("agent efficiency guidance", () => {
	it("finishes promptly from successful tool evidence without waiting for user confirmation", () => {
		expect(attemptCompletion.function.description).toContain("finish promptly")
		expect(attemptCompletion.function.description).toContain("do not wait for separate user confirmation")
		expect(attemptCompletion.function.description).not.toContain("code corruption and system failure")
	})

	it("reserves todo tracking for genuinely complex work", () => {
		expect(updateTodoList.function.description).toContain("at least three independently meaningful work items")
		expect(updateTodoList.function.description).toContain("Routine inspect/edit/validate work")
	})

	it("keeps link formatting out of internal reasoning and tool arguments", () => {
		const section = markdownFormattingSection()
		expect(section).toContain("user-facing Markdown")
		expect(section).toContain("Do not spend task time")
		expect(section).not.toContain("ALL responses MUST")
	})
})
