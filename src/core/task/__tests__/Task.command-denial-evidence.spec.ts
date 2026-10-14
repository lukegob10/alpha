import { afterEach, describe, expect, it, vi } from "vitest"

import { createAgentResponse } from "../../agent/AgentResponse"
import { createAgentLifecycleSnapshot } from "../../agent/lifecycle/reducer"
import { ToolScheduler, type ToolExecutionHost, type ToolSchedulerResult } from "../../agent/ToolScheduler"
import { applyPatchTool } from "../../tools/ApplyPatchTool"
import { executeCommandTool } from "../../tools/ExecuteCommandTool"
import { createTaskToolSurface } from "../../tools/TaskToolSurface"
import { createToolFailure, type ToolFailureMetadata } from "../../tools/ToolFailure"
import { ToolRepetitionDetector } from "../../tools/ToolRepetitionDetector"
import { Task, type CommandExecutionEvidence } from "../Task"

const COMMAND = "rm --help"

const PATCH_COMMAND =
	"apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: fixture.txt\n+fixture\n*** End Patch\nPATCH"
const UNSETTLED_RECEIPT = {
	checkId: "pending-check",
	definitionDigest: "check-definition",
	executionId: "check-execution",
	status: "running" as const,
	observedAt: 1,
}

function createTask(initialEvidence: readonly CommandExecutionEvidence[] = []) {
	return Object.assign(Object.create(Task.prototype), {
		taskKind: "primary",
		workspacePath: process.cwd(),
		abort: false,
		didComplete: false,
		taskCancellationController: new AbortController(),
		pendingCommandVerification: Promise.resolve(),
		pendingCommandVerificationCount: 0,
		commandExecutionEvidence: new Map(initialEvidence.map((evidence) => [evidence.toolCallId, evidence])),
		toolRepetitionDetector: new ToolRepetitionDetector(0),
		userMessageContent: [],
		providerRef: { deref: () => undefined },
	}) as Task
}

function deniedResult(
	callId: string,
	overrides: Partial<ToolFailureMetadata> = {},
	scopeKind: ToolFailureMetadata["affectedScope"]["kind"] = "capability",
): ToolSchedulerResult {
	return {
		callId,
		name: "exec_command",
		status: "denied",
		content: JSON.stringify({
			status: "denied",
			message: "This command is denied by the current execution policy.",
		}),
		durationMs: 0,
		failure: {
			...createToolFailure({
				reason: "policy_denied",
				scopeKind,
				scopeIdentity: "command-denial-evidence-fixture",
				effectsStarted: "no",
				outcome: "known",
				recovery: { kind: "user-action" },
			}),
			...overrides,
		},
	}
}

async function observeDenied(
	task: Task,
	callId: string,
	reason: "policy_denied" | "approval_denied" = "policy_denied",
) {
	await task.recordToolCallForStopping(
		"exec_command",
		{ cmd: COMMAND },
		"denied",
		undefined,
		deniedResult(callId, { reason }),
	)
}

afterEach(() => vi.restoreAllMocks())

describe("Task denied command attempt evidence", () => {
	it.each(["policy_denied", "approval_denied"] as const)(
		"records a %s attempt once across replay without starting a process or verification",
		async (reason) => {
			const task = createTask()
			const begin = vi.spyOn(task, "beginCommandExecution")
			const admit = vi.spyOn(task, "admitCommandExecution")
			await observeDenied(task, "denied-command", reason)
			const first = task.getCommandExecutionEvidence()
			expect(first).toHaveLength(1)
			expect(first[0]).toMatchObject({ toolCallId: "denied-command", command: COMMAND, status: "denied" })
			expect(first[0].completedAt).toBe(first[0].startedAt)
			for (const property of [
				"exitCode",
				"signalName",
				"verificationChangeSetIds",
				"verificationVersions",
				"acceptanceChecks",
			]) {
				expect(first[0]).not.toHaveProperty(property)
			}

			await Promise.all([
				observeDenied(task, "denied-command", reason),
				observeDenied(task, "denied-command", reason),
			])

			expect(task.getCommandExecutionEvidence()).toEqual(first)
			expect(task.hasActiveCommandExecutions()).toBe(false)
			expect(begin).not.toHaveBeenCalled()
			expect(admit).not.toHaveBeenCalled()
		},
	)

	it.each(["running", "succeeded", "failed"] as const)(
		"preserves existing %s execution evidence when a denied receipt is replayed for its ID",
		async (status) => {
			const task = createTask()
			task.beginCommandExecution("existing-command", "real-execution", "git status")
			if (status !== "running")
				task.completeCommandExecution("existing-command", { exitCode: status === "succeeded" ? 0 : 1 })
			const before = task.getCommandExecutionEvidence()

			await observeDenied(task, "existing-command")

			expect(task.getCommandExecutionEvidence()).toEqual(before)
		},
	)

	it("evicts the oldest settled attempt while retaining active execution and unsettled acceptance evidence", async () => {
		const unsettled: CommandExecutionEvidence = {
			toolCallId: "unsettled-command",
			executionId: "unsettled-execution",
			command: "git status",
			status: "failed",
			startedAt: 1,
			completedAt: 2,
			acceptanceChecks: [UNSETTLED_RECEIPT],
		}
		const task = createTask([unsettled])
		task.beginCommandExecution("active-command", "active-execution", "git status")
		for (let index = 2; index < 128; index++) {
			task.beginCommandExecution(`settled-${index}`, `execution-${index}`, "git status")
			task.completeCommandExecution(`settled-${index}`, { exitCode: 0 })
		}
		const active = task.getCommandExecutionEvidence()[1]

		await observeDenied(task, "new-denied-command")

		const evidence = task.getCommandExecutionEvidence()
		expect(evidence).toHaveLength(128)
		expect(evidence.find(({ toolCallId }) => toolCallId === "active-command")).toEqual(active)
		expect(evidence.find(({ toolCallId }) => toolCallId === "unsettled-command")).toEqual(unsettled)
		expect(evidence.find(({ toolCallId }) => toolCallId === "settled-2")).toBeUndefined()
		expect(evidence.at(-1)).toMatchObject({ toolCallId: "new-denied-command", command: COMMAND, status: "denied" })
	})

	it.each(["running", "unsettled", "associated", "versions", "diagnostics"] as const)(
		"keeps the ledger bounded when every existing entry is %s",
		async (state) => {
			const task = createTask(
				Array.from(
					{ length: 128 },
					(_, index): CommandExecutionEvidence => ({
						toolCallId: `protected-${index}`,
						executionId: `execution-${index}`,
						command: "git status",
						status: state === "running" ? "running" : "failed",
						startedAt: 1,
						...(state === "unsettled" ? { completedAt: 2, acceptanceChecks: [UNSETTLED_RECEIPT] } : {}),
						...(state === "associated" ? { verificationChangeSetIds: ["change-set"] } : {}),
						...(state === "versions"
							? {
									verificationVersions: {
										"change-set": {
											contentVersion: 1,
											contentFingerprint: "content",
											scopePath: ".",
											commandDigest: "command",
											repositoryDigest: "repository",
										},
									},
								}
							: {}),
						...(state === "diagnostics"
							? {
									verificationDiagnostics: [
										{
											code: "unavailable_scope" as const,
											message: "Verification scope unavailable.",
										},
									],
								}
							: {}),
					}),
				),
			)
			const before = task.getCommandExecutionEvidence()

			await observeDenied(task, "denied-at-capacity")

			expect(task.getCommandExecutionEvidence()).toEqual(before)
			expect(task.getCommandExecutionEvidence()).toHaveLength(128)
		},
	)

	it.each(["success", "denied"] as const)(
		"keeps an intercepted apply_patch %s result out of command execution evidence",
		async (status) => {
			const task = createTask()
			const command = PATCH_COMMAND
			const result = { ...deniedResult("intercepted-patch", {}, "workspace"), status }

			await task.recordToolCallForStopping("exec_command", { cmd: command }, status, undefined, result)

			expect(task.getCommandExecutionEvidence()).toEqual([])
			expect(task.hasActiveCommandExecutions()).toBe(false)
		},
	)

	it.each(["command-prefix", "patch-workspace"] as const)(
		"distinguishes a native patch command denial from an intercepted workspace denial (%s)",
		async (route) => {
			const task = createTask()
			const surface = createTaskToolSurface({
				mode: "code",
				cwd: task.cwd,
				taskKind: "primary",
				approvalMode: "bypass",
				autoApprovalEnabled: true,
				execution: {
					workspaceRoots: [task.cwd],
					command: {
						allowedPrefixes: ["*"],
						deniedPrefixes: route === "command-prefix" ? ["apply_patch"] : [],
					},
				},
			})
			expect(surface.isCallable("exec_command")).toBe(true)
			expect(surface.isCallable("apply_patch")).toBe(true)
			const denyPatch = vi
				.spyOn(task, "getTaskToolDenialReason")
				.mockImplementation((name) =>
					name === "apply_patch" ? "Patch path is outside the approved write scope." : undefined,
				)
			const execute = vi
				.spyOn(executeCommandTool, "execute")
				.mockRejectedValue(new Error("Unexpected command execution"))
			const patch = vi.spyOn(applyPatchTool, "handle").mockRejectedValue(new Error("Unexpected patch execution"))
			const observe = vi.fn(task.recordToolCallForStopping.bind(task))
			const onEffectStart = vi.fn()
			const host: ToolExecutionHost = {
				taskId: "intercepted-patch-denial",
				taskKind: "primary",
				cwd: task.cwd,
				taskFacade: task,
				userMessageContent: task.userMessageContent,
				ask: vi.fn<NonNullable<ToolExecutionHost["ask"]>>().mockResolvedValue({ response: "noButtonClicked" }),
				say: vi.fn(async () => undefined),
				recordToolUsage: vi.fn(),
				recordToolCallForStopping: observe,
				pushToolResultToUserContent(result) {
					task.userMessageContent.push(result)
					return true
				},
			}
			const outcome = await new ToolScheduler({
				task,
				executionHost: host,
				registry: surface.registry,
				policy: surface.policy,
				mode: "code",
				onEffectStart,
			}).run(
				createAgentResponse([
					{
						type: "tool_call",
						id: "intercepted-patch",
						name: "exec_command",
						arguments: { cmd: PATCH_COMMAND },
					},
				]),
			)

			if (route === "patch-workspace") {
				expect(denyPatch).toHaveBeenCalledWith("apply_patch", {
					patch: "*** Begin Patch\n*** Add File: fixture.txt\n+fixture\n*** End Patch",
				})
			} else {
				expect(denyPatch).not.toHaveBeenCalled()
			}
			expect(outcome.results).toHaveLength(1)
			expect(outcome.results[0]).toMatchObject({
				callId: "intercepted-patch",
				name: "exec_command",
				status: "denied",
				failure: {
					reason: "policy_denied",
					affectedScope: { kind: route === "command-prefix" ? "capability" : "workspace" },
					effectsStarted: "no",
					outcome: "known",
				},
			})
			expect(observe).toHaveBeenCalledOnce()
			expect(task.userMessageContent).toMatchObject([
				{ type: "tool_result", tool_use_id: "intercepted-patch", is_error: true },
			])
			if (route === "patch-workspace") {
				expect(task.getCommandExecutionEvidence()).toEqual([])
			} else {
				expect(task.getCommandExecutionEvidence()).toHaveLength(1)
				expect(task.getCommandExecutionEvidence()[0]).toMatchObject({
					toolCallId: "intercepted-patch",
					command: PATCH_COMMAND,
					status: "denied",
				})
			}
			expect(execute).not.toHaveBeenCalled()
			expect(patch).not.toHaveBeenCalled()
			expect(host.ask).not.toHaveBeenCalled()
			expect(onEffectStart).not.toHaveBeenCalled()
		},
	)

	it("does not replace a lifecycle effect start with pre-effect denied attempt evidence", async () => {
		const task = createTask()
		const snapshot = createAgentLifecycleSnapshot({
			taskId: "denial-lifecycle",
			runId: "current-run",
			turnId: "current-turn",
		})
		snapshot.acceptedToolCallIds.push("command_with_punctuation")
		snapshot.effectStartedToolCallIds.push("command_with_punctuation")
		Object.assign(task, {
			taskId: snapshot.taskId,
			agentRunId: snapshot.runId,
			agentTurnId: snapshot.turnId,
			providerRef: { deref: () => ({ getAgentLifecycleSnapshot: () => snapshot }) },
		})

		await observeDenied(task, "command:with punctuation")

		expect(task.getCommandExecutionEvidence()).toEqual([])
	})

	it.each(["abort", "didComplete"] as const)(
		"does not insert evidence after %s while observation waits for pending publication",
		async (state) => {
			const task = createTask()
			let release!: () => void
			Object.assign(task, { pendingCommandVerification: new Promise<void>((resolve) => (release = resolve)) })
			const observation = observeDenied(task, "waiting-command")
			Reflect.set(task, state, true)
			release()
			await observation

			expect(task.getCommandExecutionEvidence()).toEqual([])
		},
	)

	it("ignores ambiguous command arguments and untrusted denial text without failure metadata", async () => {
		for (const [args, result] of [
			[{ cmd: COMMAND, command: "git status" }, deniedResult("conflicting")],
			[{ cmd: 1 }, deniedResult("malformed")],
			[{ cmd: COMMAND }, { ...deniedResult("opaque"), failure: undefined }],
		] as const) {
			const task = createTask()
			await task.recordToolCallForStopping("exec_command", args, "denied", undefined, result)
			expect(task.getCommandExecutionEvidence()).toEqual([])
		}
	})

	it.each([
		{ effectsStarted: "yes" as const },
		{ effectsStarted: "unknown" as const, outcome: "unknown" as const },
		{ reason: "execution_failed" as const },
	])("does not label a started or uncertain failure as a denied attempt (%j)", async (failure) => {
		const task = createTask()
		await task.recordToolCallForStopping(
			"exec_command",
			{ cmd: COMMAND },
			"denied",
			undefined,
			deniedResult("uncertain", failure),
		)

		expect(task.getCommandExecutionEvidence()).toEqual([])
	})
})
