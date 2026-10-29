import crypto from "crypto"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import type { AlphaProvider } from "../../core/webview/AlphaProvider"
import { recoverTaskHistory } from "../recoverTaskHistory"
import { readApiMessages } from "../../core/task-persistence/apiMessages"

vi.mock("vscode", () => ({
	window: {
		showQuickPick: vi.fn(),
		showTextDocument: vi.fn(),
		showWarningMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showErrorMessage: vi.fn(),
	},
	workspace: { openTextDocument: vi.fn() },
	Uri: { file: (filePath: string) => filePath },
}))
vi.mock("../../i18n", () => ({ t: (key: string, values?: unknown) => `${key}${values ? JSON.stringify(values) : ""}` }))

let directory: string
let filePath: string
const source = JSON.stringify([{ role: "user", content: "hello" }, null])

beforeEach(async () => {
	vi.clearAllMocks()
	directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-native-recovery-"))
	await fs.mkdir(path.join(directory, "tasks", "task"), { recursive: true })
	filePath = path.join(directory, "tasks", "task", "api_conversation_history.json")
	await fs.writeFile(filePath, source)
	vi.mocked(vscode.window.showQuickPick)
		.mockResolvedValueOnce({ label: "task", taskId: "task" } as never)
		.mockResolvedValueOnce([{ label: "record", index: 1 }] as never)
	vi.mocked(vscode.window.showWarningMessage).mockResolvedValue("common:historyRecovery.confirm" as never)
})

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true })
})

function provider() {
	return {
		taskHistoryStore: { getAll: () => [{ id: "task", ts: 1 }] },
		getLiveTask: vi.fn(),
		getTaskOwner: vi.fn(),
		contextProxy: { globalStorageUri: { fsPath: directory } },
		runTaskHistoryRecovery: vi.fn(async (_id: string, recover: () => Promise<unknown>) => recover()),
	} as unknown as Parameters<typeof recoverTaskHistory>[0]
}

it("previews original bytes and confirms exact digest/indexes before publishing repaired history and receipt", async () => {
	const host = provider()
	await recoverTaskHistory(host)
	expect(vscode.window.showTextDocument).toHaveBeenCalledOnce()
	expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
		"common:historyRecovery.warning",
		expect.objectContaining({
			modal: true,
			detail: expect.stringContaining(crypto.createHash("sha256").update(source).digest("hex")),
		}),
		"common:historyRecovery.confirm",
	)
	expect(await readApiMessages({ taskId: "task", globalStoragePath: directory })).toEqual([
		{ role: "user", content: "hello" },
	])
	expect(host.runTaskHistoryRecovery).toHaveBeenCalledOnce()
	expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
})

it("makes no changes when confirmation is cancelled", async () => {
	vi.mocked(vscode.window.showWarningMessage).mockReset().mockResolvedValue(undefined)
	const host = provider()
	await recoverTaskHistory(host)
	expect(host.runTaskHistoryRecovery).not.toHaveBeenCalled()
	expect(await fs.readFile(filePath, "utf8")).toBe(source)
})

it("rejects ownership acquired while the confirmation was open", async () => {
	const host = provider()
	vi.mocked(host.runTaskHistoryRecovery).mockRejectedValue(new Error("Task became live"))
	await recoverTaskHistory(host)
	expect(await fs.readFile(filePath, "utf8")).toBe(source)
	expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:historyRecovery.failed")
})

it("does not offer a live task for selection", async () => {
	const host = provider()
	vi.mocked(host.getLiveTask).mockReturnValue({} as ReturnType<AlphaProvider["getLiveTask"]>)
	vi.mocked(vscode.window.showQuickPick).mockReset().mockResolvedValue(undefined)
	await recoverTaskHistory(host)
	expect(vscode.window.showQuickPick).toHaveBeenCalledWith([], expect.any(Object))
	expect(host.runTaskHistoryRecovery).not.toHaveBeenCalled()
})
