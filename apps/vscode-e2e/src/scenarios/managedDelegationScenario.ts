import { createHash } from "node:crypto"
import { toolNames, type AlphaCodeSettings, type AlphaMessage, type ToolName } from "@alpha-code/types"

import { inspectToolTransactions } from "./transactionAssertions"

const DIRECTORY = "managed-delegation"
const approvals = new WeakSet<object>()
const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const object = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

export interface ManagedDelegationScenario {
	prompt: string
	approval: Readonly<{ source: "runner-explicit-request"; promptSha256: string }>
	children: readonly { name: string; role: "explore" | "worker"; message: string; report: string }[]
	files: Readonly<Record<string, string>>
	readCommands: readonly string[]
	resultPath: string
	canaryPath: string
	expectedResult: string
	expectedAnswer: string
}

/** The opt-in belongs to this runner invocation; model text and serialized receipts cannot grant it. */
export function createManagedDelegationScenario(nonce: string): ManagedDelegationScenario {
	if (!/^[a-f0-9]{24}$/.test(nonce)) throw new Error("Invalid managed scenario nonce")
	const directory = `${DIRECTORY}/${nonce}`
	const left = 10 + (Number.parseInt(nonce.slice(0, 6), 16) % 89)
	const right = 10 + (Number.parseInt(nonce.slice(6, 12), 16) % 89)
	const resultPath = `${directory}/result.json`
	const canaryPath = `${directory}/unrelated.txt`
	const expectedResult = `${JSON.stringify({ left, right, total: left + right })}\n`
	const expectedAnswer = `left=${left};right=${right};total=${left + right}`
	const readCommands = ["left", "right"].map(
		(side) => `node -e "process.stdout.write(require('node:fs').readFileSync('${directory}/${side}.json','utf8'))"`,
	)
	const children: ManagedDelegationScenario["children"] = [
		...(["left", "right"] as const).map((side, index) => ({
			name: `${side}_review`,
			role: "explore" as const,
			message: `Read ${directory}/${side}.json using exec_command with exactly this command: ${readCommands[index]}. Return ${side}=VALUE from the file. Do not edit, delegate or execute other commands.`,
			report: `${side}=${side === "left" ? left : right}`,
		})),
		{
			name: "scoped_writer",
			role: "worker",
			message: `Use apply_patch to replace {} in ${resultPath} with ${expectedResult.trim()}. Change only that file. Do not run commands or delegate. Return integrated=${nonce}.`,
			report: `integrated=${nonce}`,
		},
	]
	const prompt = [
		"I explicitly authorize exactly three managed sub-agents for this disposable evaluation.",
		"Launch left_review and right_review as explorer agents, with fork_turns none, and collect both reports with wait_agent.",
		...children.slice(0, 2).map((child) => `${child.name}: ${child.message}`),
		`After both reports, launch one worker named scoped_writer with fork_turns none. Tell it to write ${resultPath} as a JSON object with numeric left, right and total fields, using the values in the two reports and their sum. It may edit only ${resultPath}; it must not delegate or execute commands. Ask it to return integrated=${nonce}.`,
		"Collect the Worker result and let Alpha integrate its change. Preserve all concurrent edits to unrelated.txt.",
		"Do not write files yourself, create other tasks, use network services, install dependencies, or launch further children.",
		"Finish with only left=NUMBER;right=NUMBER;total=NUMBER using the collected reports.",
	].join("\n")
	const approval = Object.freeze({ source: "runner-explicit-request" as const, promptSha256: digest(prompt) })
	approvals.add(approval)
	return Object.freeze({
		prompt,
		approval,
		children: Object.freeze(children),
		readCommands: Object.freeze(readCommands),
		resultPath,
		canaryPath,
		expectedResult,
		expectedAnswer,
		files: Object.freeze({
			[`${directory}/left.json`]: `${JSON.stringify({ value: left })}\n`,
			[`${directory}/right.json`]: `${JSON.stringify({ value: right })}\n`,
			[resultPath]: "{}\n",
			[canaryPath]: "baseline unrelated content\n",
		}),
	})
}

/** This dedicated surface never changes the ordinary workflow's disabled tools. */
export function managedDelegationConfiguration(
	original: AlphaCodeSettings,
	scenario: ManagedDelegationScenario,
	approval: unknown,
): AlphaCodeSettings {
	const authorized =
		approval === scenario.approval &&
		approvals.has(scenario.approval) &&
		scenario.approval.promptSha256 === digest(scenario.prompt)
	const allowed = new Set<ToolName>(["exec_command", "shell", "execute_command", "attempt_completion"])
	if (authorized)
		for (const name of ["spawn_agent", "wait_agent", "cancel_agent", "apply_patch"] as const) allowed.add(name)
	return {
		...original,
		mode: "code",
		approvalMode: "auto",
		autoApprovalEnabled: true,
		disabledTools: toolNames.filter((name) => !allowed.has(name)),
		subagentsEnabled: authorized,
		alwaysAllowSubagents: authorized,
		alwaysAllowSubtasks: false,
		alwaysAllowReadOnly: true,
		alwaysAllowReadOnlyOutsideWorkspace: false,
		alwaysAllowWrite: authorized,
		alwaysAllowWriteOutsideWorkspace: false,
		alwaysAllowWriteProtected: false,
		alwaysAllowExecute: true,
		allowedCommands: [...scenario.readCommands],
		deniedCommands: [],
		alwaysAllowMcp: false,
		mcpEnabled: false,
		alwaysAllowFollowupQuestions: false,
		maxConcurrentSubagents: 2,
		maxConcurrentTasks: 4,
		allowedMaxRequests: 24,
		enableCheckpoints: false,
		requestDelaySeconds: 0,
		writeDelayMs: 0,
		commandExecutionTimeout: 15,
		terminalShellIntegrationDisabled: true,
	}
}

export interface ManagedDelegationEvidence {
	rootTaskId: string
	rootHistory: unknown[]
	children: {
		taskId: string
		parentTaskId: string
		role: string
		status: string
		completionCount: number
		history: unknown[]
		changeSetStatus?: string
	}[]
	files: Record<string, string>
	expectedCanary: string
	rootCompletionCount: number
	capacity: { active: number; queued: number }
}

function pairs(history: unknown[]) {
	const blocks = history.flatMap((message, messageIndex) => {
		const content = object(message)?.content
		return Array.isArray(content)
			? content.flatMap((block) => {
					const parsed = object(block)
					return parsed ? [{ block: parsed, messageIndex }] : []
				})
			: []
	})
	return blocks
		.filter(({ block }) => block.type === "tool_use")
		.map(({ block: call, messageIndex }) => ({
			name: call.name,
			input: object(call.input),
			messageIndex,
			result: blocks.find(({ block }) => block.type === "tool_result" && block.tool_use_id === call.id)?.block,
		}))
}

function jsonObjectEquals(actual: string | undefined, expected: string): boolean {
	try {
		const value = object(JSON.parse(actual ?? ""))
		const wanted = object(JSON.parse(expected))!
		return (
			value !== undefined &&
			Object.keys(value).length === Object.keys(wanted).length &&
			Object.entries(wanted).every(([key, expectedValue]) => value[key] === expectedValue)
		)
	} catch {
		return false
	}
}

function resultObject(result: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	const content = result?.content
	const texts =
		typeof content === "string"
			? [content]
			: Array.isArray(content)
				? content.map((part) => object(part)?.text)
				: []
	for (const text of texts) {
		if (typeof text !== "string") continue
		try {
			const parsed = object(JSON.parse(text))
			if (parsed) return parsed
		} catch {
			/* Ordinary tool output is not a native spawn handle. */
		}
	}
	return undefined
}

function hasReport(summary: unknown, expected: string): boolean {
	const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	return typeof summary === "string" && new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`).test(summary)
}

function collectedManagedNotifications(history: unknown[]) {
	const waitIds = new Set<unknown>()
	const notifications: { notification: Record<string, unknown>; messageIndex: number }[] = []
	const parse = (text: unknown) => {
		if (typeof text !== "string") return undefined
		try {
			return object(JSON.parse(text))
		} catch {
			return undefined
		}
	}
	for (const [messageIndex, entry] of history.entries()) {
		const message = object(entry)
		const blocks = Array.isArray(message?.content) ? message.content.map(object) : []
		if (message?.role === "assistant") {
			for (const block of blocks)
				if (block?.type === "tool_use" && block.name === "wait_agent") waitIds.add(block.id)
			continue
		}
		if (message?.role !== "user") continue
		const receipted = blocks.some((block) => {
			if (block?.type !== "tool_result" || block.is_error === true || !waitIds.has(block.tool_use_id))
				return false
			const texts =
				typeof block.content === "string"
					? [block.content]
					: Array.isArray(block.content)
						? block.content.map((part) => object(part)?.text)
						: []
			return texts.some((text) => {
				const receipt = parse(text)
				return (
					receipt?.source === "managed_agent_mailbox" &&
					typeof receipt.claimId === "string" &&
					receipt.claimId.length > 0
				)
			})
		})
		for (const block of blocks) {
			const notification = block?.type === "text" ? parse(block.text) : undefined
			const automatic =
				message.input_origin === "agent" &&
				typeof message.agent_message_id === "string" &&
				message.agent_message_id.length > 0 &&
				notification?.eventId === message.agent_message_id
			if (
				(receipted || automatic) &&
				notification?.source === "managed_agent_notification" &&
				notification.kind === "result" &&
				object(notification.payload)?.status === "completed"
			)
				notifications.push({ notification, messageIndex })
		}
	}
	return notifications
}

export function collectedManagedReports(history: unknown[]): string {
	return collectedManagedNotifications(history)
		.map(({ notification }) => JSON.stringify(notification.payload))
		.join("\n")
}

/** A durable send receipt can precede consumption of the exact resume ask and the next provider step. */
export function managedResumeModelStepStarted(
	messages: readonly AlphaMessage[],
	ask: AlphaMessage | undefined,
	boundary: { ask: Pick<AlphaMessage, "ask" | "ts">; after: number; guidance: string; requests: number },
	requests: number,
): boolean {
	const fresh = messages.filter((message) => message.ts > boundary.after)
	const admitted = fresh.findIndex(
		(message) =>
			message.type === "say" &&
			message.say === "user_feedback" &&
			message.partial !== true &&
			message.text === boundary.guidance,
	)
	if (
		requests > boundary.requests &&
		admitted >= 0 &&
		fresh.slice(admitted + 1).some((message) => message.type === "say" && message.say === "api_req_started")
	)
		return true
	if (ask && !ask.partial && !ask.isAnswered && (ask.ts !== boundary.ask.ts || ask.ask !== boundary.ask.ask))
		throw new Error(`Unexpected managed boundary before resumed model step: ${ask.ask}`)
	return false
}

/** The scripted control must observe denial of the forced native call, not just absence of a child. */
export function inspectManagedDelegationRefusal(history: unknown[], minimumForcedAttempts = 0): string[] {
	const attempts = pairs(history).filter((call) => call.name === "spawn_agent")
	const failures: string[] = []
	if (inspectToolTransactions(history).errors.length > 0) failures.push("tool_transactions")
	if (attempts.length < minimumForcedAttempts) failures.push("forced_spawn_not_observed")
	// This fixture disables spawn at its captured policy surface. Launcher/schema/cancellation errors do not prove it.
	if (
		attempts.some((call) => {
			const receipt = resultObject(call.result)
			return (
				call.result?.is_error !== true ||
				receipt?.status !== "denied" ||
				![
					'Tool "spawn_agent" is not allowed by the current step policy.',
					"Subagents are disabled in Agents settings.",
				].includes(String(receipt.message))
			)
		})
	)
		failures.push("spawn_not_denied")
	return failures
}

/** Uses persisted transactions, independently observed effects and actual ownership, never success prose alone. */
export function inspectManagedDelegationOutcome(
	scenario: ManagedDelegationScenario,
	evidence: ManagedDelegationEvidence,
): string[] {
	const failures = new Set<string>()
	const check = (condition: boolean, code: string) => {
		if (!condition) failures.add(code)
	}
	const children = evidence.children
	check(children.length === 3, "child_count")
	check(new Set(children.map((child) => child.taskId)).size === children.length, "child_identity")
	check(
		children.every((child) => child.parentTaskId === evidence.rootTaskId && child.taskId !== evidence.rootTaskId),
		"child_ownership",
	)
	check(
		children.every((child) => child.status === "completed" && child.completionCount === 1),
		"children_completed_once",
	)
	check(evidence.rootCompletionCount === 1, "root_completed_once")
	check(evidence.capacity.active === 0 && evidence.capacity.queued === 0, "capacity_released")
	const parentCalls = pairs(evidence.rootHistory)
	const assignedLaunches = scenario.children.map((expected) => {
		const launches = parentCalls.filter(
			(call) =>
				call.name === "spawn_agent" &&
				call.input?.task_name === expected.name &&
				call.result &&
				call.result.is_error !== true,
		)
		return launches.length === 1 ? launches[0] : undefined
	})
	const assignedChildren = assignedLaunches.map((launch, index) => {
		const handle = resultObject(launch?.result)
		const expected = scenario.children[index]!
		return children.find((child) => child.taskId === handle?.taskId && child.role === expected.role)
	})
	check(
		parentCalls.filter((call) => call.name === "spawn_agent" && call.result?.is_error !== true).length === 3 &&
			assignedChildren.every((child) => child !== undefined) &&
			new Set(assignedChildren.map((child) => child?.taskId)).size === 3,
		"parent_spawned_children",
	)
	check(
		parentCalls.every((call) => ["spawn_agent", "wait_agent", "attempt_completion"].includes(String(call.name))),
		"parent_did_not_edit",
	)
	const notifications = collectedManagedNotifications(evidence.rootHistory)
	const reportDelivered = (index: number, before = Infinity) => {
		const child = assignedChildren[index]
		const launch = assignedLaunches[index]
		return (
			child !== undefined &&
			launch !== undefined &&
			notifications.some(
				({ notification, messageIndex }) =>
					messageIndex > launch.messageIndex &&
					messageIndex < before &&
					notification.senderTaskId === child.taskId &&
					notification.recipientTaskId === evidence.rootTaskId &&
					hasReport(object(notification.payload)?.summary, scenario.children[index]!.report),
			)
		)
	}
	check(
		scenario.children.every((_expected, index) => reportDelivered(index)),
		"parent_collected_reports",
	)
	const finalEntry = evidence.rootHistory
		.map((message, messageIndex) => ({ message: object(message), messageIndex }))
		.reverse()
		.find(({ message }) => message?.role === "assistant")
	const final = finalEntry?.message
	const workerLaunch = assignedLaunches[2]
	check(
		workerLaunch !== undefined &&
			scenario.children
				.slice(0, 2)
				.every((_expected, index) => reportDelivered(index, workerLaunch.messageIndex)) &&
			reportDelivered(2, finalEntry?.messageIndex ?? -1),
		"parent_handoff_order",
	)
	const finalBlocks = Array.isArray(final?.content) ? final.content.map(object) : []
	const answer = finalBlocks
		.map((block) =>
			block?.type === "text"
				? block.text
				: block?.name === "attempt_completion"
					? object(block.input)?.result
					: "",
		)
		.filter((text) => typeof text === "string")
		.join("\n")
		.trim()
	check(final?.role === "assistant" && answer === scenario.expectedAnswer, "parent_synthesis")
	check(
		[evidence.rootHistory, ...children.map((child) => child.history)].every(
			(history) => inspectToolTransactions(history).errors.length === 0,
		),
		"tool_transactions",
	)
	const reviewers = children.filter((child) => child.role === "explore")
	check(
		reviewers.length === 2 &&
			assignedChildren[0]?.taskId !== assignedChildren[1]?.taskId &&
			scenario.readCommands.every((command, index) => {
				const child = assignedChildren[index]
				return (
					child?.role === "explore" &&
					pairs(child.history).some(
						(call) =>
							call.name === "exec_command" &&
							call.input?.cmd === command &&
							call.result &&
							call.result.is_error !== true,
					)
				)
			}),
		"child_source_read",
	)
	for (const child of children) {
		const calls = pairs(child.history)
		check(
			calls.every((call) =>
				(child.role === "worker"
					? ["apply_patch", "attempt_completion"]
					: ["exec_command", "attempt_completion"]
				).includes(String(call.name)),
			),
			"child_tool_surface",
		)
		check(
			calls.every(
				(call) => call.name !== "exec_command" || scenario.readCommands.includes(String(call.input?.cmd)),
			),
			"child_commands_scoped",
		)
		if (child.role !== "worker") continue
		check(child.changeSetStatus === "applied", "worker_integrated")
		const edits = calls.filter((call) => call.name === "apply_patch")
		check(
			edits.length > 0 &&
				edits.every((call) => {
					const patch = call.input?.patch
					if (typeof patch !== "string" || call.result?.is_error === true) return false
					const targets = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(
						(match) => match[1],
					)
					return (
						targets.length > 0 &&
						targets.every((target) => target === scenario.resultPath) &&
						!patch.includes("*** Move to:")
					)
				}),
			"worker_patch_scope",
		)
	}
	check(children.filter((child) => child.role === "worker").length === 1, "worker_count")
	check(jsonObjectEquals(evidence.files[scenario.resultPath], scenario.expectedResult), "final_result")
	check(evidence.files[scenario.canaryPath] === evidence.expectedCanary, "concurrent_edit_preserved")
	check(
		Object.entries(scenario.files).every(
			([file, content]) =>
				file === scenario.resultPath || file === scenario.canaryPath || evidence.files[file] === content,
		),
		"input_files_preserved",
	)
	check(
		Object.keys(evidence.files).sort().join("\n") === Object.keys(scenario.files).sort().join("\n"),
		"unexpected_files",
	)
	return [...failures]
}
