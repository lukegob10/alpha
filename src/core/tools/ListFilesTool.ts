import * as path from "path"
import * as fs from "fs/promises"

import { type ClineSayTool } from "@alpha-code/types"

import { Task } from "../task/Task"
import { formatResponse } from "../prompts/responses"
import { listFiles } from "../../services/glob/list-files"
import type { ToolUse } from "../../shared/tools"

import { BaseTool, ToolCallbacks, ToolReadDeniedError } from "./BaseTool"
import { getTaskReadablePath, isTaskPathOutsideWorkspace } from "./taskPathPresentation"
import type { PreparedToolRead, TaskReadGrant } from "./ToolRegistry"
import { isPathAllowed, isToolAllowed, type ToolPolicySnapshot } from "../agent/ToolPolicy"
import { checkAutoApproval } from "../auto-approval"

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

interface ListFilesParams {
	path: string
	recursive?: boolean
}

export class ListFilesTool extends BaseTool<"list_files"> {
	readonly name = "list_files" as const

	/**
	 * The bounded lane lists one ordinary directory without following links. It has
	 * no Task.ask path: a revoked grant produces a denied receipt and the next step
	 * can use the normal serial approval path. Read state is local until finalize.
	 */
	async prepareParallelRead(
		task: Task,
		call: ToolUse,
		grant: TaskReadGrant,
		policy: ToolPolicySnapshot,
		signal?: AbortSignal,
	): Promise<PreparedToolRead | undefined> {
		const args = call.nativeArgs as Partial<ListFilesParams> | undefined
		if (
			!grant.enabled ||
			!policy.approval.autoApprovalEnabled ||
			!!process.env.RIPGREP_CONFIG_PATH ||
			!isToolAllowed(policy, "list_files") ||
			task.taskKind !== "primary" ||
			task.cwd !== grant.workspaceRoot ||
			typeof args?.path !== "string" ||
			!args.path ||
			(args.recursive !== undefined && args.recursive !== false)
		)
			return undefined

		const relPath = args.path
		const ignoreController = task.rooIgnoreController
		const ignoreContent = ignoreController?.rooIgnoreContent
		const protectedController = task.rooProtectedController
		const absolutePath = path.resolve(grant.workspaceRoot, relPath)
		if (!isInside(grant.workspaceRoot, absolutePath) || !isPathAllowed(policy, absolutePath, task.cwd))
			return undefined
		const pathIsAllowed = () =>
			task.rooIgnoreController === ignoreController &&
			ignoreController?.rooIgnoreContent === ignoreContent &&
			task.rooProtectedController === protectedController &&
			!isTaskPathOutsideWorkspace(task, absolutePath) &&
			task.rooIgnoreController?.validateAccess(absolutePath) !== false &&
			task.rooProtectedController?.isWriteProtected(absolutePath) !== true
		if (!pathIsAllowed()) return undefined
		const message = () => ({
			tool: "listFilesTopLevel" as const,
			path: getTaskReadablePath(task, relPath),
			isOutsideWorkspace: false,
		})
		const approvalIsCurrent = async () => {
			// getState refreshes provider/UI configuration and can write settings.
			// Read only the synchronous cached values in a concurrent worker.
			const state = task.providerRef.deref()?.getValues()
			const decision = await checkAutoApproval({ state, ask: "tool", text: JSON.stringify(message()) })
			return { state, approved: decision.decision === "approve" && !state?.disabledTools?.includes("list_files") }
		}
		// Revocation also gates metadata preflight, not only the expensive scan.
		if (!(await approvalIsCurrent()).approved || task.abort) {
			throw new ToolReadDeniedError(
				"The captured read approval was revoked. Retry through the serial approval path.",
			)
		}
		signal?.throwIfAborted()

		// Scope discovery is fenced by the scheduler and bounded to one directory.
		// Aliases/junctions are deliberately excluded instead of guessing overlap.
		const canonicalPath = async () => {
			const root = await fs.realpath(grant.workspaceRoot)
			// Legacy directory filtering inherits ancestor .gitignore files. Strict
			// reads cannot load their contents outside the workspace, so any such
			// configuration makes the whole call serial instead of changing output.
			let ancestor = path.dirname(root)
			for (let depth = 0; ; depth++) {
				signal?.throwIfAborted()
				if (depth >= 64) return undefined
				try {
					await fs.lstat(path.join(ancestor, ".gitignore"))
					return undefined
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined
				}
				const parent = path.dirname(ancestor)
				if (parent === ancestor) break
				ancestor = parent
			}
			const candidate = await fs.realpath(absolutePath)
			signal?.throwIfAborted()
			if (
				!isInside(root, candidate) ||
				path.relative(absolutePath, candidate) !== "" ||
				!(await fs.lstat(candidate)).isDirectory()
			) {
				return undefined
			}
			// No-follow listings must retain legacy output for admitted directories.
			// Bound topology inspection, and serialize directories containing links
			// or more entries than the listing's own output budget.
			let entries = 0
			const directory = await fs.opendir(candidate)
			for await (const entry of directory) {
				signal?.throwIfAborted()
				if (entry.isSymbolicLink() || ++entries > 200) return undefined
				// Windows opendir can classify a junction as a plain directory.
				// lstat inspects the entry itself and reliably exposes that link.
				if ((await fs.lstat(path.join(candidate, entry.name))).isSymbolicLink()) return undefined
			}
			return candidate
		}
		let scope: string | undefined
		try {
			scope = await canonicalPath()
		} catch {
			signal?.throwIfAborted()
			return undefined
		}
		if (!scope) return undefined
		const capturedScope = scope
		const assertAuthorized = async (activeSignal?: AbortSignal) => {
			activeSignal?.throwIfAborted()
			if (!(await approvalIsCurrent()).approved) {
				throw new ToolReadDeniedError(
					"The captured read approval was revoked. Retry through the serial approval path.",
				)
			}
			activeSignal?.throwIfAborted()
			if (task.abort || task.cwd !== grant.workspaceRoot || (await canonicalPath()) !== capturedScope) {
				throw new ToolReadDeniedError(
					"The captured directory scope is no longer available for parallel reading.",
				)
			}
			const { state, approved } = await approvalIsCurrent()
			activeSignal?.throwIfAborted()
			if (task.abort || !pathIsAllowed() || !approved) {
				throw new ToolReadDeniedError(
					"The captured read approval was revoked. Retry through the serial approval path.",
				)
			}
			return state
		}

		return {
			scope: capturedScope,
			run: async (activeSignal) => {
				await assertAuthorized(activeSignal)
				const [files, didHitLimit] = await listFiles(absolutePath, false, 200, activeSignal, {
					followSymlinks: false,
					rejectOnError: true,
					workspaceRoot: grant.workspaceRoot,
				})
				activeSignal?.throwIfAborted()
				return async () => {
					const state = await assertAuthorized(activeSignal)
					const result = formatResponse.formatFilesList(
						absolutePath,
						files,
						didHitLimit,
						task.rooIgnoreController,
						grant.showIgnoredFiles && state?.showRooIgnoredFiles === true,
						task.rooProtectedController,
					)
					task.consecutiveMistakeCount = 0
					await task.say("tool", JSON.stringify({ ...message(), content: result } satisfies ClineSayTool))
					await assertAuthorized(activeSignal)
					return result
				}
			},
		}
	}

	async execute(params: ListFilesParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { path: relDirPath, recursive } = params
		const { askApproval, handleError, pushToolResult } = callbacks

		try {
			if (!relDirPath) {
				task.consecutiveMistakeCount++
				task.recordToolError("list_files")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("list_files", "path"))
				return
			}

			task.consecutiveMistakeCount = 0

			const absolutePath = path.resolve(task.cwd, relDirPath)
			const isOutsideWorkspace = isTaskPathOutsideWorkspace(task, absolutePath)

			const [files, didHitLimit] = await listFiles(absolutePath, recursive || false, 200, callbacks.signal)
			const { showRooIgnoredFiles = false } = (await task.providerRef.deref()?.getState()) ?? {}

			const result = formatResponse.formatFilesList(
				absolutePath,
				files,
				didHitLimit,
				task.rooIgnoreController,
				showRooIgnoredFiles,
				task.rooProtectedController,
			)

			const sharedMessageProps: ClineSayTool = {
				tool: !recursive ? "listFilesTopLevel" : "listFilesRecursive",
				path: getTaskReadablePath(task, relDirPath),
				isOutsideWorkspace,
			}

			const completeMessage = JSON.stringify({ ...sharedMessageProps, content: result } satisfies ClineSayTool)
			const didApprove = await askApproval("tool", completeMessage)

			if (!didApprove) {
				return
			}

			pushToolResult(result)
		} catch (error) {
			await handleError("listing files", error)
		}
	}

	override async handlePartial(task: Task, block: ToolUse<"list_files">): Promise<void> {
		const relDirPath: string | undefined = block.params.path
		const recursiveRaw: string | undefined = block.params.recursive
		const recursive = recursiveRaw?.toLowerCase() === "true"

		const absolutePath = relDirPath ? path.resolve(task.cwd, relDirPath) : task.cwd
		const isOutsideWorkspace = isTaskPathOutsideWorkspace(task, absolutePath)

		const sharedMessageProps: ClineSayTool = {
			tool: !recursive ? "listFilesTopLevel" : "listFilesRecursive",
			path: getTaskReadablePath(task, relDirPath ?? ""),
			isOutsideWorkspace,
		}

		const partialMessage = JSON.stringify({ ...sharedMessageProps, content: "" } satisfies ClineSayTool)
		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const listFilesTool = new ListFilesTool()
