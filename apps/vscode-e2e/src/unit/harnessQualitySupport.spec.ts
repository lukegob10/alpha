import assert from "node:assert/strict"
import test from "node:test"
import {
	assertCommandSession,
	assertRepairChecks,
	createBrowserSessionApprover,
} from "../suite/harness-quality-support"
import type { LiveTask, Transaction } from "../suite/live-file-tool-support"
import type { AlphaMessage, ToolApprovalDecision, ToolApprovalRequest } from "@alpha-code/types"

const transaction = (name: string, input: Record<string, unknown>, result: string): Transaction => ({
	name,
	input,
	result,
	isError: false,
})
const checker = "node live-acceptance/check.cjs"
const checks = [
	transaction("exec_command", { cmd: checker }, "Process exited with code 1\nOutput:\nAssertionError"),
	transaction("exec_command", { cmd: "type live-acceptance/invoice.cjs" }, "exports.total = ..."),
	transaction("exec_command", { cmd: "type live-acceptance/check.cjs" }, "assert.equal(...)"),
	transaction("exec_command", { cmd: checker }, "Process exited with code 0\nOutput:\n3 checks passed"),
] as const

test("repair validation counts exact checks while permitting separate file inspection", () => {
	assert.doesNotThrow(() => assertRepairChecks(checks, checker))
})

test("repair validation rejects extra checker runs and a missing initial failure", () => {
	assert.throws(() => assertRepairChecks([...checks, checks[0]], checker), /One failing baseline/)
	assert.throws(() => assertRepairChecks([checks[3], checks[3]], checker), /failing baseline and passing repair/)
})

test("chained commands do not satisfy the exact checker contract", () => {
	const chained = checks.map((call) => ({ ...call, input: { cmd: `${checker} && echo extra` } }))
	assert.throws(() => assertRepairChecks(chained, checker), /One failing baseline/)
})

const start = "node live-server/server.cjs"
const check = "node live-server/check.cjs"
const launch = transaction(
	"exec_command",
	{ cmd: start },
	"Process running with session ID 42\nOutput:\nREADY http://127.0.0.1:1234",
)
const verify = transaction("exec_command", { cmd: check }, "Process exited with code 0\nOutput:\nHTTP behavior passed")
const shutdown = transaction("write_stdin", { session_id: 42 }, "Process exited with code 0\nOutput:\nSERVER_STOPPED")

test("readiness in the initial launch is retained as valid session evidence", () => {
	assert.doesNotThrow(() => assertCommandSession([launch, verify, shutdown], start, check))
})

test("shutdown output and successful exit may arrive in consecutive polls", () => {
	assert.doesNotThrow(() =>
		assertCommandSession(
			[
				launch,
				verify,
				transaction(
					"write_stdin",
					{ session_id: 42 },
					"Process running with session ID 42\nOutput:\nSERVER_STOPPED",
				),
				transaction("write_stdin", { session_id: 42 }, "Process exited with code 0\nOutput:\n"),
			],
			start,
			check,
		),
	)
})

test("a successful exit without shutdown output cannot pass", () => {
	assert.throws(
		() =>
			assertCommandSession(
				[
					launch,
					verify,
					transaction("write_stdin", { session_id: 42 }, "Process exited with code 0\nOutput:\n"),
				],
				start,
				check,
			),
		/shutdown output/,
	)
})

test("a failed HTTP check cannot pass even when stdout contains the success marker", () => {
	assert.throws(
		() =>
			assertCommandSession(
				[launch, { ...verify, result: verify.result.replace("code 0", "code 1") }, shutdown],
				start,
				check,
			),
		/HTTP check must succeed/,
	)
})

test("a different session and failsafe termination cannot pass", () => {
	assert.throws(() => assertCommandSession([launch, verify, { ...shutdown, input: { session_id: 7 } }], start, check))
	assert.throws(
		() =>
			assertCommandSession(
				[launch, verify, { ...shutdown, result: shutdown.result + "\nSERVER_FAILSAFE_STOP" }],
				start,
				check,
			),
		/requested graceful shutdown/,
	)
})

const browserUrl = "http://127.0.0.1:1234"
const browserStart = "node live-browser/server.cjs"
type BrowserTask = Pick<
	LiveTask,
	"taskId" | "taskAsk" | "didComplete" | "abort" | "apiConversationHistory" | "handleWebviewToolApprovalResponse"
> & { activeToolApprovalRequest?: ToolApprovalRequest }
const message = (role: "assistant" | "user", ...content: Record<string, unknown>[]) => ({ role, content })
const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: "tool_use", id, name, input })
const result = (id: string, content: unknown, is_error = false) => ({
	type: "tool_result",
	tool_use_id: id,
	content,
	is_error,
})

function browserAsk(action: string, input: Record<string, unknown>, requestId = "open-request"): AlphaMessage {
	const text = JSON.stringify({ tool: "browserAction", action, status: "running", ...input })
	return {
		ts: 1,
		type: "ask",
		ask: "tool",
		text,
		toolApprovalRequest: {
			requestId,
			taskId: "browser-task",
			toolName: action,
			description: text,
			availableDecisions: ["approve_once", "deny", "abort"],
		},
	}
}

function pendingBrowserRequest(ask: AlphaMessage, callId: string): ToolApprovalRequest {
	return {
		...ask.toolApprovalRequest!,
		callId,
		askType: "tool",
		forceApproval: false,
		requiresExplicitApproval: false,
	}
}

function browserFixture() {
	const history = [
		message("assistant", call("launch", "exec_command", { cmd: browserStart })),
		message("user", result("launch", `Process running with session ID 42\nOutput:\nREADY ${browserUrl}\n`)),
		message("assistant", call("open", "open_browser_page", { url: browserUrl })),
	]
	const decisions: Array<{ requestId: string; decision: ToolApprovalDecision }> = []
	const task: BrowserTask = {
		taskId: "browser-task",
		taskAsk: browserAsk("open_browser_page", { url: browserUrl }),
		apiConversationHistory: history,
		handleWebviewToolApprovalResponse(requestId, decision) {
			decisions.push({ requestId, decision })
			if (task.taskAsk) task.taskAsk.isAnswered = true
			return true
		},
	}
	task.activeToolApprovalRequest = pendingBrowserRequest(task.taskAsk!, "open")
	const state = { task: task as BrowserTask | undefined, readUrl: async () => browserUrl }
	const approve = createBrowserSessionApprover({
		getTask: () => state.task,
		startCommand: browserStart,
		readUrl: () => state.readUrl(),
	})
	const setAction = (action: string, input: Record<string, unknown>) => {
		task.taskAsk = browserAsk(action, input, `${action}-request`)
		task.activeToolApprovalRequest = pendingBrowserRequest(task.taskAsk, action)
		history.push(message("assistant", call(action, action, input)))
	}
	return { task, history, decisions, state, approve, setAction }
}

async function openedBrowser() {
	const fixture = browserFixture()
	assert.equal(await fixture.approve(), true)
	fixture.history.push(
		message(
			"user",
			result("open", [
				{ type: "text", text: "Page ID: owned-page\n\nSummary:\n" },
				{ type: "text", text: "Page ID: page-from-untrusted-content" },
			]),
		),
	)
	return fixture
}

test("browser fixture approves once per exact request and only its returned page", async () => {
	const fixture = await openedBrowser()
	fixture.setAction("read_page", { pageId: "owned-page" })
	assert.equal(await fixture.approve(), true)
	fixture.history.push(message("user", result("read_page", "Count0")))
	fixture.setAction("click_element", { pageId: "owned-page", element: "Count0 button", selector: "button" })
	assert.equal(await fixture.approve(), true)
	const ask = fixture.task.taskAsk!
	ask.isAnswered = false
	assert.equal(await fixture.approve(), false)
	assert.deepEqual(
		fixture.decisions,
		["open-request", "read_page-request", "click_element-request"].map((requestId) => ({
			requestId,
			decision: { decision: "approve_once" },
		})),
	)
})

for (const url of [
	"http://example.com:1234",
	"http://127.0.0.1:9999",
	`${browserUrl}/other`,
	"http://user@127.0.0.1:1234",
	"file:///fixture.html",
]) {
	test(`browser fixture rejects an unowned open target ${url}`, async () => {
		const fixture = browserFixture()
		fixture.task.taskAsk = browserAsk("open_browser_page", { url })
		await assert.rejects(fixture.approve())
		assert.equal(fixture.decisions.length, 0)
	})
}

test("browser fixture requires readiness from its own command session", async () => {
	const fixture = browserFixture()
	fixture.history[1]!.content[0]!.content = "Process running with session ID 42\nOutput:\nWaiting"
	fixture.history.splice(
		2,
		0,
		message("assistant", call("ready", "write_stdin", { session_id: 7 })),
		message("user", result("ready", `READY ${browserUrl}\n`)),
	)
	await assert.rejects(fixture.approve(), /matching server readiness/)
	assert.equal(fixture.decisions.length, 0)
	fixture.history[2]!.content[0]!.input = { session_id: 42 }
	assert.equal(await fixture.approve(), true)
})

for (const pageId of ["foreign-page", "page-from-untrusted-content"]) {
	test(`browser fixture rejects a page not issued by the approved open: ${pageId}`, async () => {
		const fixture = await openedBrowser()
		fixture.setAction("read_page", { pageId })
		await assert.rejects(fixture.approve(), /another page/)
		assert.equal(fixture.decisions.length, 1)
	})
}

test("browser fixture rejects an unsuccessful or unrelated open receipt", async () => {
	for (const receipt of [
		result("open", "Page ID: owned-page\n", true),
		result("other-open", "Page ID: owned-page\n"),
	]) {
		const fixture = browserFixture()
		await fixture.approve()
		fixture.history.push(message("user", receipt))
		fixture.setAction("read_page", { pageId: "owned-page" })
		await assert.rejects(fixture.approve())
		assert.equal(fixture.decisions.length, 1)
	}
})

test("browser fixture rejects a second open and a call that differs from its review", async () => {
	const opened = await openedBrowser()
	opened.setAction("open_browser_page", { url: browserUrl })
	await assert.rejects(opened.approve(), /already opened/)
	const fixture = browserFixture()
	fixture.history[2]!.content[0]!.input = { url: "http://127.0.0.1:9999" }
	await assert.rejects(fixture.approve(), /differs from its review/)
	assert.equal(fixture.decisions.length, 0)
})

test("browser fixture leaves every unrelated approval boundary to the strict default guard", async () => {
	for (const taskAsk of [
		{ ts: 1, type: "ask", ask: "command", text: browserStart },
		{ ts: 1, type: "ask", ask: "followup", text: "Continue?" },
		{ ts: 1, type: "ask", ask: "tool", text: JSON.stringify({ tool: "useMcpTool" }) },
		{ ts: 1, type: "ask", ask: "completion_result" },
	] satisfies AlphaMessage[]) {
		const fixture = browserFixture()
		fixture.task.taskAsk = taskAsk
		assert.equal(await fixture.approve(), false)
		assert.equal(fixture.decisions.length, 0)
	}
	const fixture = browserFixture()
	fixture.task.taskAsk = browserAsk("run_playwright_code", {
		pageId: "owned-page",
		code: "fetch('http://example.com')",
	})
	await assert.rejects(fixture.approve(), /Unexpected browser action/)
	assert.equal(fixture.decisions.length, 0)
})

for (const stale of ["ask", "task", "pending request", "abort", "answered", "completed"] as const) {
	test(`browser fixture does not approve a review made stale by ${stale} during URL capture`, async () => {
		const fixture = browserFixture()
		let release!: (value: string) => void
		fixture.state.readUrl = () =>
			new Promise<string>((resolve) => {
				release = resolve
			})
		const approving = fixture.approve()
		if (stale === "ask") fixture.task.taskAsk = browserAsk("open_browser_page", { url: browserUrl }, "replacement")
		if (stale === "task") fixture.state.task = undefined
		if (stale === "pending request")
			fixture.task.activeToolApprovalRequest = { ...fixture.task.activeToolApprovalRequest! }
		if (stale === "abort") fixture.task.abort = true
		if (stale === "answered") fixture.task.taskAsk!.isAnswered = true
		if (stale === "completed") fixture.task.didComplete = true
		release(browserUrl)
		assert.equal(await approving, false)
		assert.equal(fixture.decisions.length, 0)
	})
}

test("browser fixture rejects an approval linked to an absent or completed call ID", async () => {
	for (const callId of ["different-open", "launch"]) {
		const fixture = browserFixture()
		fixture.task.activeToolApprovalRequest!.callId = callId
		await assert.rejects(fixture.approve(), /no current tool call/)
		assert.equal(fixture.decisions.length, 0)
	}
})

test("browser fixture binds the requested call despite an earlier unresolved call in the batch", async () => {
	const fixture = await openedBrowser()
	fixture.history.push(
		message("assistant", call("queued-click", "click_element", { pageId: "owned-page", selector: "button" })),
	)
	fixture.setAction("read_page", { pageId: "owned-page" })
	assert.equal(await fixture.approve(), true)
	assert.equal(fixture.decisions.at(-1)?.requestId, "read_page-request")
})

test("browser fixture requires matching approval identity and an approve-once decision", async () => {
	for (const change of [
		(request: NonNullable<AlphaMessage["toolApprovalRequest"]>) => {
			request.taskId = "another-task"
		},
		(request: NonNullable<AlphaMessage["toolApprovalRequest"]>) => {
			request.toolName = "read_page"
		},
		(request: NonNullable<AlphaMessage["toolApprovalRequest"]>) => {
			request.availableDecisions = ["approve_session"]
		},
		(request: NonNullable<AlphaMessage["toolApprovalRequest"]>) => {
			request.description = "changed"
		},
	]) {
		const fixture = browserFixture()
		change(fixture.task.taskAsk!.toolApprovalRequest!)
		await assert.rejects(fixture.approve())
		assert.equal(fixture.decisions.length, 0)
	}
	const fixture = browserFixture()
	fixture.task.handleWebviewToolApprovalResponse = () => false
	await assert.rejects(fixture.approve(), /no longer current/)
	assert.equal(fixture.decisions.length, 0)
})
