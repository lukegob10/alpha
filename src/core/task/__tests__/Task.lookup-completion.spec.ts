import type { TaskWorkPlan } from "@alpha-code/types"

import { Task, type CommandExecutionEvidence } from "../Task"
import type { ParentCompletionDecision } from "../../agent/ParentVerification"

const lookupHistory = [
	{
		role: "user" as const,
		content: "<user_message>\nWhere is retryLimit defined?\n</user_message>",
	},
]

const implementHistory = [
	{
		role: "user" as const,
		content: "<user_message>\nImplement retry backoff in the scheduler.\n</user_message>",
	},
]

const plan: TaskWorkPlan = {
	objective: "Fix behavior",
	constraints: [],
	notes: [],
	checks: [
		{
			id: "behavior",
			description: "Behavioral check",
			command: "node app.js",
			cwd: null,
			paths: ["app.js"],
			reusable: true,
		},
	],
}

function command(overrides: Partial<CommandExecutionEvidence> = {}): CommandExecutionEvidence {
	return {
		toolCallId: "inspect",
		executionId: "execution",
		status: "running",
		startedAt: 1,
		returnedInBackground: true,
		...overrides,
	}
}

function taskWith(options: {
	history: typeof lookupHistory
	commands?: CommandExecutionEvidence[]
	plan?: TaskWorkPlan
	allowed?: boolean
	decision?: Partial<ParentCompletionDecision>
	pendingCommandVerificationCount?: number
}): Task {
	return Object.assign(Object.create(Task.prototype), {
		taskKind: "primary",
		apiConversationHistory: options.history,
		metadata: { task: options.history[0]?.content },
		workContext: options.plan ? { plan: options.plan, receipts: [], skills: [] } : undefined,
		workspacePath: process.cwd(),
		getOpenTodoCompletionDecision: () => undefined,
		commandExecutionEvidence: new Map((options.commands ?? []).map((item) => [item.toolCallId, item])),
		pendingCommandVerification: Promise.resolve(),
		pendingCommandVerificationCount: options.pendingCommandVerificationCount ?? 0,
		completionRuntimeRevision: 0,
		alphaIgnoreController: { validateAccess: () => true },
		providerRef: {
			deref: () => ({
				getParentCompletionDecision: async () =>
					({
						allowed: options.allowed ?? true,
						blockingObligations: [],
						...options.decision,
					}) satisfies ParentCompletionDecision,
			}),
		},
	}) as Task
}

describe("lookup-class completion gate", () => {
	it("completes a lookup after ordinary text even if a backgrounded inspection is still recorded as running", async () => {
		const task = taskWith({
			history: lookupHistory,
			commands: [command()],
		})
		expect(await task.getCompletionGateDecision()).toMatchObject({
			allowed: true,
			classification: "ready",
			reasonCode: "ready",
		})
	})

	it("still waits for a foreground lookup command that has not returned", async () => {
		const task = taskWith({
			history: lookupHistory,
			commands: [command({ returnedInBackground: false })],
		})
		expect(await task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			classification: "waiting",
			reasonCode: "command_running",
		})
	})

	it("still waits for a backgrounded command on an implementation turn", async () => {
		const task = taskWith({
			history: implementHistory,
			commands: [command()],
		})
		expect(await task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			classification: "waiting",
			reasonCode: "command_running",
		})
	})

	it("still blocks lookup completion when declared acceptance checks are outstanding", async () => {
		const task = taskWith({
			history: lookupHistory,
			commands: [command()],
			plan,
			allowed: true,
		})
		expect(await task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			classification: "repairable",
			reasonCode: "verification_missing",
		})
	})

	it("does not complete a mutation with a declared check on ordinary text", async () => {
		const task = taskWith({
			history: implementHistory,
			plan,
			allowed: true,
		})
		expect(await task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			classification: "repairable",
			reasonCode: "verification_missing",
		})
	})
})
