import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import * as vscode from "vscode"

import type { NavigateCodeParams } from "@alpha-code/types"
import type { Task } from "../../task/Task"
import { navigateCodeTool } from "../NavigateCodeTool"

vi.mock("vscode", async (load) => ({
	...(await load<typeof vscode>()),
	Position: class {
		constructor(
			readonly line: number,
			readonly character: number,
		) {}
		isEqual(other: vscode.Position) {
			return this.line === other.line && this.character === other.character
		}
	},
	Uri: { file: (fsPath: string) => ({ scheme: "file", fsPath }) },
	workspace: { openTextDocument: vi.fn() },
	commands: { executeCommand: vi.fn() },
}))

const openDocument = vi.mocked(vscode.workspace.openTextDocument)
const provider = vi.mocked(vscode.commands.executeCommand)
const approval = vi.fn(async () => true)
const result = vi.fn()
const metadata = vi.fn()
let temp: string
let cwd: string
let task: Task
const args: NavigateCodeParams = { operation: "definition", path: "input.ts", line: 2, column: 5 }
const callbacks = { askApproval: approval, pushToolResult: result, setResultMetadata: metadata, handleError: vi.fn() }

function location(file: string, line = 0, character = 0) {
	return { uri: vscode.Uri.file(file), range: { start: new vscode.Position(line, character) } }
}

beforeEach(async () => {
	vi.resetAllMocks()
	approval.mockResolvedValue(true)
	temp = await mkdtemp(path.join(tmpdir(), "alpha-navigate-"))
	cwd = path.join(temp, "workspace")
	await mkdir(cwd)
	await Promise.all(["input.ts", "target.ts", "ignored.ts"].map((file) => writeFile(path.join(cwd, file), "symbol")))
	await writeFile(path.join(temp, "outside.ts"), "outside")
	task = {
		cwd,
		alphaIgnoreController: { validateAccess: (file: string) => path.basename(file) !== "ignored.ts" },
	} as Task
	openDocument.mockResolvedValue({
		uri: vscode.Uri.file(path.join(cwd, "input.ts")),
		validatePosition: (position: vscode.Position) => (position.line < 4 ? position : new vscode.Position(3, 0)),
	} as vscode.TextDocument)
})
afterEach(async () => rm(temp, { recursive: true, force: true }))

it("projects locations and links into distinct one-based workspace positions in provider order", async () => {
	const target = location(path.join(cwd, "target.ts"), 5, 9)
	const selection = { start: new vscode.Position(6, 2) }
	provider.mockResolvedValue([
		{ targetUri: target.uri, targetRange: target.range, targetSelectionRange: selection },
		target,
		target,
		{ targetUri: target.uri, targetRange: target.range },
		location(path.join(temp, "outside.ts")),
		location(path.join(cwd, "ignored.ts")),
		{ ...target, uri: { scheme: "https" } },
	])
	await navigateCodeTool.execute(args, task, callbacks)
	expect(provider).toHaveBeenCalledWith(
		"vscode.executeDefinitionProvider",
		expect.anything(),
		new vscode.Position(1, 4),
	)
	expect(JSON.parse(result.mock.calls[0][0])).toEqual({
		locations: [
			{ path: "target.ts", line: 7, column: 3 },
			{ path: "target.ts", line: 6, column: 10 },
		],
		truncated: false,
	})
})

it("returns an empty references result when the host has no matches", async () => {
	provider.mockResolvedValue(undefined)
	await navigateCodeTool.execute({ ...args, operation: "references" }, task, callbacks)
	expect(provider).toHaveBeenCalledWith("vscode.executeReferenceProvider", expect.anything(), expect.anything())
	expect(JSON.parse(result.mock.calls[0][0])).toEqual({ locations: [], truncated: false })
})

it("filters junction escapes and accepts workspace roots opened through a junction", async () => {
	const alias = path.join(temp, "alias")
	await symlink(cwd, alias, "junction")
	await symlink(temp, path.join(cwd, "parent"), "junction")
	Object.assign(task, { cwd: alias })
	provider.mockResolvedValue([
		location(path.join(cwd, "parent", "outside.ts")),
		location(path.join(cwd, "target.ts")),
		location(path.join(alias, "target.ts")),
	])
	await navigateCodeTool.execute(args, task, callbacks)
	expect(JSON.parse(result.mock.calls[0][0]).locations).toEqual([{ path: "target.ts", line: 1, column: 1 }])
})

it.each(["../outside.ts", "ignored.ts"])("denies a restricted input %s before invoking the host", async (file) => {
	await navigateCodeTool.execute({ ...args, path: file }, task, callbacks)
	expect(metadata).toHaveBeenCalledWith({ status: "denied" })
	expect(approval).not.toHaveBeenCalled()
	expect(openDocument).not.toHaveBeenCalled()
})

it("respects read approval and rejects positions past the end of the document", async () => {
	approval.mockResolvedValueOnce(false)
	await navigateCodeTool.execute(args, task, callbacks)
	expect(metadata).toHaveBeenCalledWith({ status: "denied" })
	expect(openDocument).not.toHaveBeenCalled()
	await navigateCodeTool.execute({ ...args, line: 7 }, task, callbacks)
	expect(metadata).toHaveBeenCalledWith({ status: "error" })
	expect(provider).not.toHaveBeenCalled()
})

it("suppresses results when the source becomes ignored during lookup", async () => {
	provider.mockImplementationOnce(async () => {
		vi.spyOn(task.alphaIgnoreController!, "validateAccess").mockReturnValue(false)
		return [location(path.join(cwd, "target.ts"))]
	})
	await navigateCodeTool.execute(args, task, callbacks)
	expect(metadata).toHaveBeenCalledWith({ status: "denied" })
	expect(result.mock.calls[0][0]).not.toContain("target.ts")
})

it("cancels pending host work without emitting its late result", async () => {
	const controller = new AbortController()
	let release!: () => void
	provider.mockImplementationOnce(() => {
		controller.abort(new Error("navigation cancelled"))
		return new Promise<void>((resolve) => {
			release = resolve
		})
	})
	await expect(navigateCodeTool.execute(args, task, { ...callbacks, signal: controller.signal })).rejects.toThrow(
		"navigation cancelled",
	)
	release()
	expect(result).not.toHaveBeenCalled()
})

it("bounds processed candidates, returned locations and output characters", async () => {
	const matches = Array.from({ length: 300 }, (_, line) => location(path.join(cwd, "target.ts"), line))
	provider
		.mockResolvedValueOnce(matches)
		.mockResolvedValueOnce(matches)
		.mockResolvedValueOnce(Array(300).fill(matches[0]))
	await navigateCodeTool.execute(args, task, callbacks)
	await navigateCodeTool.execute(args, task, { ...callbacks, getRemainingOutputChars: () => 120 })
	await navigateCodeTool.execute(args, task, callbacks)
	const [full, budgeted, duplicates] = result.mock.calls.map(([value]) => JSON.parse(value))
	expect(full.locations).toHaveLength(50)
	expect(full.truncated && budgeted.truncated && duplicates.truncated).toBe(true)
	expect(result.mock.calls[1][0].length).toBeLessThanOrEqual(120)
	expect(duplicates.locations).toHaveLength(1)
})
