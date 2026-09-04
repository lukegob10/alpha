import * as vscode from "vscode"
import { Tiktoken } from "tiktoken/lite"
import o200kBase from "tiktoken/encoders/o200k_base"

import { getEnvironmentDetails, captureEnvironmentDetails } from "../getEnvironmentDetails"
import { EnvironmentContext } from "../EnvironmentContext"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import { listFiles } from "../../../services/glob/list-files"
import type { Task } from "../../task/Task"

vi.mock("vscode", () => ({
	TabInputText: class TabInputText {
		constructor(readonly uri: { fsPath: string }) {}
	},
	window: { visibleTextEditors: [], tabGroups: { all: [] } },
	workspace: { workspaceFolders: [] },
	env: { language: "en-US" },
}))
vi.mock("../../../shared/getApiMetrics", () => ({ getApiMetrics: () => ({ totalCost: 0.25 }) }))
vi.mock("../../../services/glob/list-files", () => ({ listFiles: vi.fn() }))
vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		getTerminals: vi.fn(() => []),
		getBackgroundTerminals: vi.fn(() => []),
		getUnretrievedOutput: vi.fn(() => ""),
		isProcessHot: vi.fn(() => true),
	},
}))
vi.mock("../../../integrations/terminal/Terminal", () => ({
	Terminal: { compressTerminalOutput: (text: string) => text },
}))
vi.mock("../../prompts/responses", () => ({
	formatResponse: { formatFilesList: (_cwd: string, files: string[]) => files.join("\n") },
}))
vi.mock("../../../utils/git", () => ({ getGitStatus: vi.fn(() => null) }))

describe("deterministic environment request construction measurements", () => {
	const state = { mode: "code", maxWorkspaceFiles: 50, includeCurrentTime: true, includeCurrentCost: true }
	let task: Task
	let encoder: Tiktoken
	let context: EnvironmentContext

	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"))
		vi.clearAllMocks()
		context = new EnvironmentContext()
		;(vscode.window.visibleTextEditors as unknown as unknown[]).splice(0)
		vi.mocked(TerminalRegistry.getTerminals).mockReturnValue([])
		vi.mocked(listFiles).mockResolvedValue([Array.from({ length: 50 }, (_, i) => `src/component-${i}.ts`), false])
		task = {
			cwd: "/fixture/workspace",
			taskId: "measurement-task",
			instanceId: "measurement-session",
			taskKind: "primary",
			providerRef: { deref: () => ({ getState: async () => state }) },
			getTaskMode: async () => "code",
			api: { getModel: () => ({ id: "offline-fixture" }) },
			clineMessages: [],
			fileContextTracker: { captureRecentlyModifiedFiles: () => ({ files: [], commit: () => undefined }) },
		} as unknown as Task
		encoder = new Tiktoken(o200kBase.bpe_ranks, o200kBase.special_tokens, o200kBase.pat_str)
	})

	afterEach(() => {
		encoder.free()
		vi.useRealTimers()
	})

	async function measure(includeFiles: boolean) {
		const started = Date.now()
		let settledAt = started
		const promise = captureEnvironmentDetails(task, includeFiles, undefined, { context }).then((capture) => {
			settledAt = Date.now()
			capture.commit()
			return capture.details
		})
		await vi.runAllTimersAsync()
		const details = await promise
		return {
			bytes: Buffer.byteLength(details),
			tokens: encoder.encode(details).length,
			preflightMs: settledAt - started,
			requestAdmissionMs: settledAt - started,
		}
	}

	it("records first and unchanged steps, then busy and post-edit preflight", async () => {
		const first = await measure(true)
		vi.advanceTimersByTime(1000)
		const unchanged = await measure(false)
		;(vscode.window.visibleTextEditors as unknown as { document: { uri: { fsPath: string } } }[]).push({
			document: { uri: { fsPath: "/fixture/workspace/src/changed.ts" } },
		})
		const editorChanged = await measure(false)
		const terminal = {
			id: 1,
			busy: true,
			getCurrentWorkingDirectory: () => "/fixture/workspace",
			getLastCommand: () => "pnpm dev",
			getProcessesWithOutput: () => [],
			cleanCompletedProcessQueue: () => undefined,
		}
		vi.mocked(TerminalRegistry.getTerminals).mockImplementation((busy) => (busy ? [terminal as never] : []))
		const busy = await measure(false)
		task.didEditFile = true
		const edited = await measure(false)
		console.log(JSON.stringify({ first, unchanged, editorChanged, busy, edited }))
		expect(first.bytes).toBeGreaterThan(unchanged.bytes)
		expect(unchanged).toEqual({ bytes: 0, tokens: 0, preflightMs: 0, requestAdmissionMs: 0 })
		expect(busy.preflightMs).toBe(0)
		expect(edited.preflightMs).toBe(0)
	})

	it("records cancellation while workspace listing is outstanding", async () => {
		vi.mocked(listFiles).mockImplementation(
			() => new Promise((resolve) => setTimeout(() => resolve([[], false]), 2000)),
		)
		const controller = new AbortController()
		const started = Date.now()
		let settledAt = started
		const pending = getEnvironmentDetails(task, true, undefined, { signal: controller.signal }).then(
			() => {
				settledAt = Date.now()
			},
			() => {
				settledAt = Date.now()
			},
		)
		setTimeout(() => controller.abort(new Error("measurement cancellation")), 10)
		await vi.runAllTimersAsync()
		await pending
		console.log(
			JSON.stringify({ cancellationLatencyMs: settledAt - started - 10, remainingTimers: vi.getTimerCount() }),
		)
		expect(settledAt - started - 10).toBe(0)
	})
})
