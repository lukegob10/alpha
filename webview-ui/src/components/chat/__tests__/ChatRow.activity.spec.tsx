import React, { useState } from "react"
import { act, fireEvent, render, screen, within } from "@/utils/test-utils"
import type { ClineMessage } from "@alpha-code/types"
import { ExtensionStateContextProvider } from "@src/context/ExtensionStateContext"
import { ChatRowContent } from "../ChatRow"

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key, i18n: { exists: () => true } }),
	Trans: ({ i18nKey }: { i18nKey: string }) => <span>{i18nKey}</span>,
	initReactI18next: { type: "3rdParty", init: () => undefined },
}))

const toolMessage = (tool: Record<string, unknown>, ts = 1): ClineMessage => ({
	ts,
	type: "ask",
	ask: "tool",
	text: JSON.stringify(tool),
})

function Row({ message }: { message: ClineMessage }) {
	const [expanded, setExpanded] = useState(false)
	return (
		<ChatRowContent
			message={message}
			isExpanded={expanded}
			isLast={false}
			isStreaming={false}
			onToggleExpand={() => setExpanded((value) => !value)}
		/>
	)
}

function renderRows(messages: ClineMessage[]) {
	return render(
		<ExtensionStateContextProvider>
			{messages.map((message) => (
				<Row key={message.ts} message={message} />
			))}
		</ExtensionStateContextProvider>,
	)
}

describe("compact activity steps", () => {
	it("keeps a long code search query out of the activity heading and reveals it on demand", () => {
		const query =
			"How the backend application connects to the database, configures Oracle, and handles pooled connections"
		renderRows([toolMessage({ tool: "codebaseSearch", query, path: "backend/app" })])
		const toggle = screen.getByRole("button", { name: "codebaseSearch.title", expanded: false })
		expect(toggle).not.toHaveTextContent(query)
		expect(screen.getByText(query)).not.toBeVisible()
		fireEvent.click(toggle)
		expect(screen.getByText(query)).toBeVisible()
		expect(screen.getByText("backend/app")).toBeVisible()
	})

	it("passes search context and previews through persisted result messages", () => {
		renderRows([
			{
				ts: 1,
				type: "say",
				say: "codebase_search_result",
				text: JSON.stringify({
					tool: "codebaseSearch",
					content: {
						query: "database pooling",
						results: [
							{
								filePath: "backend/app/database.py",
								startLine: 12,
								endLine: 20,
								score: 0.87,
								context: "Database.connect",
								codeChunk: "return pool.acquire()",
							},
						],
					},
				}),
			},
		])
		fireEvent.click(screen.getByRole("button", { name: "codebaseSearch.didSearch", expanded: false }))
		expect(screen.getByText("Database.connect")).toBeVisible()
		expect(screen.getByText("return pool.acquire()")).toBeVisible()
	})

	it("keeps errors identifiable while their details are collapsed", () => {
		renderRows([{ ts: 1, type: "say", say: "error", text: "The search request failed" }])
		const toggle = screen.getByRole("button", { name: "chat:error", expanded: false })
		expect(screen.getByText("The search request failed")).not.toBeVisible()
		fireEvent.click(toggle)
		expect(screen.getByText("The search request failed")).toBeVisible()
	})

	it("keeps pending subtask reviews visible in the collapsed summary", () => {
		renderRows([
			{
				ts: 1,
				type: "say",
				say: "subagent_group",
				subagentGroup: {
					groupId: "group",
					parentTaskId: "parent",
					status: "completed",
					createdAt: 1,
					agents: [
						{
							taskId: "child",
							nickname: "Maple",
							role: "worker",
							objective: "Review timer changes",
							status: "completed",
							usage: { durationMs: 100 },
							changeSet: {
								id: "change",
								status: "pending_review",
								changedFiles: ["src/timer.ts"],
								createdAt: 1,
								updatedAt: 2,
							},
						},
					],
				},
			},
		])
		const toggle = screen.getByRole("button", { name: /chat:activityTrace.needsAttention/, expanded: false })
		expect(toggle).toBeVisible()
		const details = document.getElementById(toggle.getAttribute("aria-controls")!)!
		expect(details).not.toBeVisible()
		fireEvent.click(toggle)
		expect(details).toBeVisible()
		expect(within(details).getByText("Maple")).toBeVisible()
	})

	it("collapses commentary while keeping the user message and final answer visible", () => {
		renderRows([
			{ ts: 1, type: "say", say: "user_feedback", text: "Change the timer" },
			{ ts: 2, type: "say", say: "text", text: "Inspecting the timer\nChecking cancellation too", partial: true },
			{ ts: 3, type: "say", say: "completion_result", text: "The timer now waits 60 seconds" },
		])
		expect(screen.getByText("Change the timer")).toBeVisible()
		expect(screen.getByText("The timer now waits 60 seconds")).toBeVisible()
		const toggle = screen.getByRole("button", { name: "Inspecting the timer", expanded: false })
		expect(toggle.tagName).toBe("BUTTON")
		expect(screen.queryByText(/Checking cancellation too/)).not.toBeInTheDocument()
		fireEvent.click(toggle)
		expect(screen.getByText(/Checking cancellation too/)).toBeVisible()
	})

	it.each([
		["read", { tool: "readFile", path: "src/app.ts", content: "src/app.ts" }, "src/app.ts"],
		[
			"batch read",
			{
				tool: "readFile",
				batchFiles: [
					{ path: "src/app.ts", key: "a" },
					{ path: "src/test.ts", key: "b" },
				],
			},
			"src/test.ts",
		],
		["directory listing", { tool: "listFilesRecursive", path: "src", content: "app.ts" }, "src"],
		[
			"directory batch",
			{
				tool: "listFilesTopLevel",
				batchDirs: [
					{ path: "src", key: "a" },
					{ path: "tests", key: "b" },
				],
			},
			"tests",
		],
		["edit", { tool: "appliedDiff", path: "src/app.ts", content: "" }, "src/app.ts"],
		["codebase search", { tool: "codebaseSearch", query: "timer cancellation", path: "src" }, "timer cancellation"],
		["mode switch", { tool: "switchMode", mode: "code", reason: "Implement the delay" }, "Implement the delay"],
		["skill", { tool: "skill", skill: "review", description: "Check the change" }, "Check the change"],
		[
			"slash command",
			{ tool: "runSlashCommand", command: "test", description: "Run the checks" },
			"Run the checks",
		],
		[
			"plan update",
			{ tool: "updateTodoList", todos: [{ id: "a", content: "Inspect the code", status: "pending" }] },
			"Inspect the code",
		],
	] as const)("keeps %s details hidden until its own toggle is activated", (_name, tool, detail) => {
		renderRows([toolMessage(tool)])
		const toggle = screen.getByRole("button", { expanded: false })
		const details = document.getElementById(toggle.getAttribute("aria-controls")!)!
		expect(details).not.toBeVisible()
		fireEvent.click(toggle)
		expect(toggle).toHaveAttribute("aria-expanded", "true")
		expect(screen.getByText(detail, { exact: false })).toBeVisible()
		fireEvent.click(toggle)
		expect(details).not.toBeVisible()
	})

	it("expands file steps independently", () => {
		renderRows([
			toolMessage({ tool: "readFile", path: "first.ts" }, 1),
			toolMessage({ tool: "readFile", path: "second.ts" }, 2),
		])
		const toggles = screen.getAllByRole("button", { expanded: false })
		fireEvent.click(toggles[0])
		expect(screen.getByText(/first.ts/)).toBeVisible()
		expect(screen.getByText(/second.ts/)).not.toBeVisible()
		fireEvent.click(toggles[1])
		expect(screen.getByText(/second.ts/)).toBeVisible()
		fireEvent.click(toggles[0])
		expect(screen.getByText(/first.ts/)).not.toBeVisible()
		expect(screen.getByText(/second.ts/)).toBeVisible()
	})

	it("retains MCP status updates received while details are collapsed", () => {
		renderRows([
			{
				ts: 10,
				type: "ask",
				ask: "use_mcp_server",
				text: JSON.stringify({
					type: "use_mcp_tool",
					serverName: "search-server",
					toolName: "search",
					arguments: '{"query":"alpha"}',
				}),
			},
		])
		const toggle = screen.getByRole("button", { expanded: false })
		const details = document.getElementById(toggle.getAttribute("aria-controls")!)!
		expect(details).not.toBeVisible()
		act(() =>
			window.dispatchEvent(
				new MessageEvent("message", {
					data: {
						type: "mcpExecutionStatus",
						text: JSON.stringify({
							executionId: "10",
							status: "completed",
							response: "Retained response",
						}),
					},
				}),
			),
		)
		fireEvent.click(toggle)
		expect(details).toBeVisible()
		expect(within(details).getByText("execution.completed")).toBeVisible()
	})
})
