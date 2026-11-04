import { strict as assert } from "node:assert"
import type { ToolApprovalRequest } from "@alpha-code/types"
import type { LiveTask, Transaction } from "./live-file-tool-support"

type BrowserSessionTask = Pick<
	LiveTask,
	"taskId" | "didComplete" | "abort" | "taskAsk" | "apiConversationHistory" | "handleWebviewToolApprovalResponse"
> & {
	// The UI prompt omits callId. This fixture only observes the host-owned full pending request.
	readonly activeToolApprovalRequest?: ToolApprovalRequest
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

function browserSessionCalls(history: readonly unknown[]) {
	const blocks = history.flatMap((message) => {
		const content = record(message)?.content
		return Array.isArray(content)
			? content.flatMap((part) => {
					const block = record(part)
					return block ? [block] : []
				})
			: []
	})
	return blocks.flatMap((call) => {
		const input = record(call.input)
		if (call.type !== "tool_use" || typeof call.id !== "string" || !input) return []
		const result = blocks.find((part) => part.type === "tool_result" && part.tool_use_id === call.id)
		const content = result?.content
		const output =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map((part) => record(part)?.text)
							.filter((part) => typeof part === "string")
							.join("\n")
					: ""
		return [{ id: call.id, name: call.name, input, result, output }]
	})
}

/** Only this owned browser fixture may acknowledge its exact Alpha review, before the host's separate approval. */
export function createBrowserSessionApprover(options: {
	getTask(): BrowserSessionTask | undefined
	startCommand: string
	readUrl(): Promise<string>
}) {
	const approved = new Set<string>()
	let owner: BrowserSessionTask | undefined
	let openingCallId: string | undefined
	return async (): Promise<boolean> => {
		const task = options.getTask()
		const ask = task?.taskAsk
		if (!task || task.didComplete || task.abort || !ask || ask.partial || ask.isAnswered || ask.ask !== "tool")
			return false
		const action = record(JSON.parse(ask.text ?? "null"))
		if (action?.tool !== "browserAction") return false
		assert.ok(
			["open_browser_page", "click_element", "read_page"].includes(String(action.action)),
			"Unexpected browser action",
		)
		const request = ask.toolApprovalRequest
		const pending = task.activeToolApprovalRequest
		assert.ok(
			request &&
				pending &&
				request.taskId === task.taskId &&
				request.toolName === action.action &&
				pending.requestId === request.requestId &&
				pending.taskId === request.taskId &&
				pending.toolName === request.toolName &&
				pending.askType === ask.ask,
			"Browser review identity mismatch",
		)
		assert.equal(request.description, ask.text, "Browser review description changed")
		assert.ok(request.availableDecisions.includes("approve_once"), "Browser review cannot be approved once")
		if (approved.has(request.requestId)) return false
		assert.ok(!owner || owner === task, "Browser fixture task changed")
		const expectedUrl = action.action === "open_browser_page" ? (await options.readUrl()).trim() : undefined
		// File I/O may outlive cancellation, replacement, or an already answered review.
		if (
			options.getTask() !== task ||
			task.taskAsk !== ask ||
			ask.toolApprovalRequest !== request ||
			task.activeToolApprovalRequest !== pending ||
			task.didComplete ||
			task.abort ||
			ask.isAnswered ||
			approved.has(request.requestId)
		)
			return false
		const calls = browserSessionCalls(task.apiConversationHistory)
		const current = calls.find((call) => call.id === pending.callId && !call.result)
		assert.ok(current && current.name === action.action, "Browser review has no current tool call")
		if (action.action === "open_browser_page") {
			assert.equal(openingCallId, undefined, "The browser fixture already opened its page")
			const port = /^http:\/\/127\.0\.0\.1:(\d{1,5})$/.exec(expectedUrl ?? "")?.[1]
			assert.ok(
				port && Number(port) > 0 && Number(port) <= 65535,
				"Browser fixture URL is not an owned loopback endpoint",
			)
			assert.equal(action.url, expectedUrl, "Browser origin differs from the fixture URL")
			assert.equal(current.input.url, expectedUrl, "Browser call differs from its review")
			const launches = calls.filter(
				(call) =>
					call.name === "exec_command" &&
					call.input.cmd === options.startCommand &&
					call.result &&
					call.result.is_error !== true,
			)
			assert.equal(launches.length, 1, "Browser fixture requires one successful owned server launch")
			const sessionId = /Process running with session ID (\d+)/.exec(launches[0]!.output)?.[1]
			assert.ok(sessionId, "Browser fixture server did not expose its session")
			assert.ok(
				calls.some(
					(call) =>
						call.result &&
						call.result.is_error !== true &&
						(call === launches[0] ||
							(call.name === "write_stdin" && call.input.session_id === Number(sessionId))) &&
						call.output.split(/\r?\n/).includes(`READY ${expectedUrl}`),
				),
				"Browser fixture URL has no matching server readiness receipt",
			)
		} else {
			const opened = calls.find(
				(call) => call.id === openingCallId && call.result && call.result.is_error !== true,
			)
			const pageId = opened && /^Page ID: ([^\r\n]{1,128})\r?\n/.exec(opened.output)?.[1]
			assert.ok(pageId, "The approved browser open has no successful page receipt")
			assert.equal(action.pageId, pageId, "Browser review targets another page")
			assert.equal(current.input.pageId, pageId, "Browser call targets another page")
		}
		assert.equal(
			task.handleWebviewToolApprovalResponse(request.requestId, { decision: "approve_once" }),
			true,
			"Browser review is no longer current",
		)
		approved.add(request.requestId)
		owner = task
		if (action.action === "open_browser_page") openingCallId = current.id
		return true
	}
}

export function assertRepairChecks(calls: readonly Transaction[], command: string): void {
	const checks = calls.filter((call) => call.name === "exec_command" && String(call.input.cmd).trim() === command)
	assert.equal(checks.length, 2, "One failing baseline and one passing repair check")
	assert.ok(
		checks.every((call) => !call.isError),
		"Checker process exits must retain successful tool transactions",
	)
	assert.deepEqual(
		checks.map((call) => /^Process exited with code (\d+)$/m.exec(call.result)?.[1]),
		["1", "0"],
		"Persisted tool results must show the failing baseline and passing repair",
	)
	assert.ok(checks[0] && checks[1])
	assert.match(checks[0].result, /AssertionError/)
	assert.match(checks[1].result, /3 checks passed/)
}

export function assertCommandSession(calls: readonly Transaction[], startCommand: string, checkCommand: string): void {
	const commands = calls.filter((call) => call.name === "exec_command")
	const launches = commands.filter((call) => call.input.cmd === startCommand)
	assert.equal(launches.length, 1, "The fixture must start exactly one owned server")
	const launch = launches[0]
	assert.ok(launch)
	assert.ok(!launch.isError)
	const sessionId = /Process running with session ID (\d+)/.exec(launch.result)?.[1]
	assert.ok(sessionId, "The background launch must expose a numeric session ID")
	assert.equal(commands.length, 2, "Only the fixture start and one HTTP check command may run")
	assert.ok(
		commands.some(
			(call) =>
				call.input.cmd === checkCommand &&
				!call.isError &&
				/^Process exited with code 0$/m.test(call.result) &&
				/HTTP behavior passed/.test(call.result),
		),
		"The fixture HTTP check must succeed",
	)
	const polls = calls.filter((call) => call.name === "write_stdin")
	assert.ok(polls.length > 0, "The model must use write_stdin to observe its command session")
	assert.ok(polls.every((call) => call.input.session_id === Number(sessionId) && !call.isError))
	const output = [launch.result, ...polls.map((call) => call.result)].join("\n")
	assert.match(output, /READY /, "Readiness may arrive in the launch or a subsequent poll")
	assert.doesNotMatch(output, /SERVER_FAILSAFE_STOP/, "The server must stop through the requested graceful shutdown")
	assert.ok(
		polls.some((call) => call.result.includes("SERVER_STOPPED")),
		"A session poll must deliver the owned server shutdown output",
	)
	assert.match(polls.at(-1)!.result, /^Process exited with code 0$/m, "The final poll must observe successful exit")
}
