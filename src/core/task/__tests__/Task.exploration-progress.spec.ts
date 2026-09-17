import { execFile } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { promisify } from "util"

import type { ToolSchedulerResult } from "../../agent/ToolScheduler"
import { getTrustedCommandExploration } from "../../tools/CommandExploration"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import { Task } from "../Task"

function schedulerResult(index: number, semanticFingerprint = `inspection-${index}`): ToolSchedulerResult {
	return {
		callId: `command-${index}`,
		name: "execute_command",
		status: "success",
		content: "inspection complete",
		executionStatus: "success",
		exitCode: 0,
		durationMs: 1,
		trustedExploration: {
			scope: "/workspace",
			semanticFingerprint,
		},
	}
}

function createTask(detector: ToolRepetitionDetector = new ToolRepetitionDetector(3, { noProgressLimit: 2 })) {
	const suspendAfterCurrentTurn = vi.fn()
	const task = Object.assign(Object.create(Task.prototype), {
		workspacePath: "/workspace",
		taskCancellationController: new AbortController(),
		pendingCommandVerification: Promise.resolve(),
		commandExecutionEvidence: new Map(),
		toolRepetitionDetector: detector,
		userMessageContent: [],
		providerRef: {
			deref: () => ({
				getVerificationProgressState: () => ({
					stateFingerprint: "unchanged-workspace",
					evidenceFingerprint: "unchanged-verification-evidence",
				}),
			}),
		},
		suspendAfterCurrentTurn,
	}) as Task
	return { task, suspendAfterCurrentTurn }
}

describe("Task trusted exploration progress", () => {
	it("bounds joined inspection evidence, preserves active commands, and does not issue verification credit", async () => {
		const { task } = createTask()
		const publish = vi.fn()
		Object.assign(task, {
			taskKind: "primary",
			providerRef: { deref: () => ({ recordParentVerificationEvidence: publish }) },
		})
		for (let index = 0; index < 128; index++) {
			task.beginCommandExecution(`old-${index}`, `execution-${index}`, "git status")
			if (index > 0) task.completeCommandExecution(`old-${index}`, { exitCode: 0 })
		}
		const result = {
			toolCallId: "inspection",
			executionId: "new",
			command: "rg needle src",
			cwd: "/workspace",
			status: "succeeded" as const,
			exitCode: 0,
			startedAt: 100,
			completedAt: 200,
			verificationChangeSetIds: ["must-not-credit"],
		}
		await task.recordCommandInspectionResult(result)
		await task.recordCommandInspectionResult(result)
		const evidence = task.getCommandExecutionEvidence()
		expect(evidence).toHaveLength(128)
		expect(evidence.find(({ toolCallId }) => toolCallId === "old-0")?.status).toBe("running")
		expect(evidence.find(({ toolCallId }) => toolCallId === "old-1")).toBeUndefined()
		expect(evidence.find(({ toolCallId }) => toolCallId === "inspection")).not.toHaveProperty(
			"verificationChangeSetIds",
		)
	})
	it("continues a real Git review after a recovered search error without workspace edits or new verification", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-git-review-"))
		const git = (args: string[]) => promisify(execFile)("git", args, { cwd: workspace })
		const commit = () =>
			git([
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"-c",
				"core.hooksPath=",
				"commit",
				"--quiet",
				"--allow-empty",
				"--no-gpg-sign",
				"-m",
				"Review fixture",
			])
		const { task, suspendAfterCurrentTurn } = createTask()
		try {
			await git(["init", "--quiet"])
			await commit()
			for (let index = 0; index < 16; index++) {
				await fs.writeFile(path.join(workspace, `file-${index}.ts`), `export const value${index} = ${index}\n`)
			}
			await git(["add", "."])
			await commit()
			await task.recordToolCallForStopping("search_files", { path: ".", regex: "[" }, "error", "read")
			await task.recordToolCallForStopping("search_files", { path: ".", regex: "value" }, "success", "read")
			for (let index = 0; index < 48; index++) {
				const target = `file-${Math.floor(index / 3)}.ts`
				const args =
					index % 3 === 0
						? ["show", `HEAD:${target}`]
						: index % 3 === 1
							? ["diff", "HEAD~1", "HEAD", "--", target]
							: ["ls-tree", "HEAD", "--", target]
				const { stdout } = await git(args)
				expect(stdout.length).toBeGreaterThan(0)
				const command = `git ${args.join(" ")}`
				const trustedExploration = await getTrustedCommandExploration({
					command,
					workspaceRoot: workspace,
					cwd: workspace,
					executionStatus: "succeeded",
					exitCode: 0,
				})
				await task.recordToolCallForStopping("execute_command", { command }, "success", "read", {
					...schedulerResult(index),
					content: stdout,
					trustedExploration,
				})
				// Assert at each boundary: a later read must not hide an earlier false stop.
				expect(suspendAfterCurrentTurn).not.toHaveBeenCalled()
			}
			expect(Reflect.get(task, "userMessageContent")).toEqual([])

			// Re-reading a target with cosmetic changes must still exhaust recovery.
			for (let index = 0; index < 4; index++) {
				const command = `git${" ".repeat(index + 1)}--no-pager show --format=label-${index} --no-ext-diff --no-textconv HEAD:file-0.ts`
				const trustedExploration = await getTrustedCommandExploration({
					command,
					workspaceRoot: workspace,
					cwd: workspace,
					executionStatus: "succeeded",
					exitCode: 0,
				})
				await task.recordToolCallForStopping("execute_command", { command }, "success", "read", {
					...schedulerResult(48 + index),
					trustedExploration,
				})
				if (index < 3) expect(suspendAfterCurrentTurn).not.toHaveBeenCalled()
			}
			expect(suspendAfterCurrentTurn).toHaveBeenCalledOnce()
			expect(Reflect.get(task, "userMessageContent")).toHaveLength(1)
		} finally {
			await fs.rm(workspace, { recursive: true, force: true })
		}
	})

	it("lets forty distinct successful shell inspections continue through the real Task adapter", async () => {
		const { task, suspendAfterCurrentTurn } = createTask()

		for (let index = 0; index < 40; index++) {
			await task.recordToolCallForStopping(
				"execute_command",
				{ command: `rg --files --glob file-${index}.ts` },
				"success",
				"read",
				schedulerResult(index),
			)
		}

		expect(suspendAfterCurrentTurn).not.toHaveBeenCalled()
		expect(Reflect.get(task, "userMessageContent")).toEqual([])
	})

	it("keeps exploration identity separate from verification evidence", async () => {
		const recordOutcome = vi.fn(() => ({ action: "continue", stagnantCalls: 0, retainedOutcomes: 1 }))
		const detector = { recordOutcome } as unknown as ToolRepetitionDetector
		const { task } = createTask(detector)

		await task.recordToolCallForStopping(
			"execute_command",
			{ command: "rg --files src" },
			"success",
			"read",
			schedulerResult(1, "trusted-shell-inspection"),
		)

		expect(recordOutcome).toHaveBeenCalledWith({
			toolName: "execute_command",
			args: { command: "rg --files src" },
			status: "success",
			executionStatus: "success",
			kind: "read",
			scope: "/workspace",
			stateFingerprint: "unchanged-workspace",
			evidenceFingerprint: "unchanged-verification-evidence",
			explorationFingerprint: "trusted-shell-inspection",
		})
	})

	it("still bounds repeated inspection identities despite command spelling changes", async () => {
		const { task, suspendAfterCurrentTurn } = createTask()

		for (let index = 0; index < 5; index++) {
			await task.recordToolCallForStopping(
				"execute_command",
				{ command: `rg${" ".repeat(index + 1)}--files src`, output: `timestamp-${index}` },
				"success",
				"read",
				schedulerResult(index, "same-semantic-inspection"),
			)
		}

		expect(suspendAfterCurrentTurn).toHaveBeenCalledOnce()
		expect(suspendAfterCurrentTurn).toHaveBeenCalledWith(
			expect.stringContaining("Task remains incomplete"),
			"blocked",
		)
		expect(Reflect.get(task, "userMessageContent")).toHaveLength(1)
	})
})
