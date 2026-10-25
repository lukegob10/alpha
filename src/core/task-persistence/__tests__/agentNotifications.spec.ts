import type { AgentMailboxEntry } from "@alpha-code/types"

import {
	getPersistedAgentNotificationIds,
	isAgentResultNotification,
	serializeAgentNotification,
} from "../agentNotifications"
import type { ApiMessage } from "../apiMessages"
import { invalidPersistedApiMessages } from "../validatePersistedApiMessages"

const notification: AgentMailboxEntry = {
	eventId: "child-run-one:completed",
	sequence: 1,
	createdAt: 1_000,
	rootTaskId: "root",
	senderTaskId: "child",
	senderPath: "/root/child",
	recipientTaskId: "root",
	recipientPath: "/root",
	kind: "result",
	name: "agent_completed",
	payload: { taskId: "child", status: "completed", summary: "Review finished" },
}

const waitHistory = (body = serializeAgentNotification(notification), isError = false): ApiMessage[] => [
	{ role: "assistant", content: [{ type: "tool_use", id: "wait.1", name: "wait_agent", input: {} }] },
	{
		role: "user",
		input_origin: "agent",
		content: [
			{
				type: "tool_result",
				tool_use_id: "wait_1",
				is_error: isError,
				content: JSON.stringify({ source: "managed_agent_mailbox", claimId: "wait-claim", eventCount: 1 }),
			},
			{ type: "text", text: body },
		],
	},
]

const persistedWaitFormats = [
	{
		name: "legacy call",
		call: { type: "tool_call", tool_call_id: "wait.1", name: "wait_agent", arguments: {} },
		resultIds: { tool_use_id: "wait_1" },
	},
	{
		name: "legacy result",
		call: { type: "tool_use", id: "wait.1", name: "wait_agent", input: {} },
		resultIds: { tool_call_id: "wait_1" },
	},
	{
		name: "empty canonical aliases",
		call: { type: "tool_call", id: "", tool_call_id: "wait.1", name: "wait_agent", arguments: {} },
		resultIds: { tool_use_id: "", tool_call_id: "wait_1" },
	},
	{
		name: "matching aliases",
		call: { type: "tool_call", id: "wait.1", tool_call_id: "wait.1", name: "wait_agent", arguments: {} },
		resultIds: { tool_use_id: "wait_1", tool_call_id: "wait_1" },
	},
] as const

function persistedWaitHistory(call: unknown, resultIds: Record<string, string>, isError = false): ApiMessage[] {
	const history: unknown = [
		{ role: "assistant", content: [call] },
		{
			role: "user",
			input_origin: "agent",
			content: [
				{
					type: "tool_result",
					...resultIds,
					is_error: isError,
					content: JSON.stringify({ source: "managed_agent_mailbox", claimId: "wait-claim", eventCount: 1 }),
				},
				{ type: "text", text: serializeAgentNotification(notification) },
			],
		},
	]
	// Historical aliases remain valid persisted data even though the provider SDK omits them.
	expect(invalidPersistedApiMessages(history)).toBeUndefined()
	return history as ApiMessage[]
}

it("recognizes host-authored automatic receipts without accepting human or assistant metadata", () => {
	const message: ApiMessage = {
		role: "user",
		input_origin: "human",
		agent_message_id: notification.eventId,
		content: [{ type: "text", text: serializeAgentNotification(notification) }],
	}
	expect(getPersistedAgentNotificationIds([message], [notification])).toEqual(new Set())
	expect(
		getPersistedAgentNotificationIds([{ ...message, role: "assistant", input_origin: "agent" }], [notification]),
	).toEqual(new Set())
	expect(getPersistedAgentNotificationIds([{ ...message, input_origin: "agent" }], [notification])).toEqual(
		new Set([notification.eventId]),
	)
})

it("requires a successful native wait receipt and the actual notification identity for legacy replay", () => {
	expect(getPersistedAgentNotificationIds(waitHistory(), [notification])).toEqual(new Set([notification.eventId]))
	expect(getPersistedAgentNotificationIds(waitHistory(undefined, true), [notification])).toEqual(new Set())
	expect(getPersistedAgentNotificationIds(waitHistory().slice(1), [notification])).toEqual(new Set())
	expect(
		getPersistedAgentNotificationIds(
			waitHistory(JSON.stringify({ source: "managed_agent_notification", eventId: notification.eventId })),
			[notification],
		),
	).toEqual(new Set())
	expect(
		getPersistedAgentNotificationIds(
			waitHistory(serializeAgentNotification({ ...notification, recipientTaskId: "unrelated" })),
			[notification],
		),
	).toEqual(new Set())
	expect(
		getPersistedAgentNotificationIds(
			waitHistory(
				serializeAgentNotification({
					...notification,
					payload: { ...notification.payload, summary: "Unrelated prose" },
				}),
			),
			[notification],
		),
	).toEqual(new Set())
	expect(
		getPersistedAgentNotificationIds(
			[
				{
					role: "user",
					input_origin: "human",
					content: [{ type: "text", text: serializeAgentNotification(notification) }],
				},
			],
			[notification],
		),
	).toEqual(new Set())
})

it.each(persistedWaitFormats)("recognizes $name wait receipts without rewriting history", ({ call, resultIds }) => {
	const history = persistedWaitHistory(call, resultIds)
	const before = structuredClone(history)
	expect(getPersistedAgentNotificationIds(history, [notification])).toEqual(new Set([notification.eventId]))
	expect(history).toEqual(before)
	expect(getPersistedAgentNotificationIds(persistedWaitHistory(call, resultIds, true), [notification])).toEqual(
		new Set(),
	)
	expect(
		getPersistedAgentNotificationIds(persistedWaitHistory({ ...call, name: "read_file" }, resultIds), [
			notification,
		]),
	).toEqual(new Set())
})

it("matches a legacy receipt against the same redacted payload presented to the model", () => {
	const privateEntry = { ...notification, payload: { summary: "Stored in PRIVATE_PATH" } }
	const present = (text: string) => text.replaceAll("PRIVATE_PATH", "[private]")
	const history = waitHistory(present(serializeAgentNotification(privateEntry)))
	expect(getPersistedAgentNotificationIds(history, [privateEntry], present)).toEqual(new Set([notification.eventId]))
	expect(getPersistedAgentNotificationIds(history, [privateEntry])).toEqual(new Set())
})

it("keeps turn identity across automatic and wait receipts and excludes ordinary stopped statuses", () => {
	const nextTurn = { ...notification, eventId: "child-run-two:completed", sequence: 2 }
	const history = waitHistory()
	history.push({
		role: "user",
		input_origin: "agent",
		agent_message_id: nextTurn.eventId,
		content: [{ type: "text", text: serializeAgentNotification(nextTurn) }],
	})
	expect(getPersistedAgentNotificationIds(history, [notification, nextTurn])).toEqual(
		new Set([notification.eventId, nextTurn.eventId]),
	)
	for (const status of ["completed", "failed", "blocked", "timed_out"]) {
		expect(isAgentResultNotification({ ...notification, payload: { status } })).toBe(true)
	}
	for (const status of ["pending", "running", "interrupted", "cancelled", "cancelling"]) {
		expect(isAgentResultNotification({ ...notification, payload: { status } })).toBe(false)
	}
})
