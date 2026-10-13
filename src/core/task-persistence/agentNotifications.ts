import type { AgentLifecycleStatus, AgentMailboxEntry } from "@alpha-code/types"
import { isDeepStrictEqual } from "util"

import { sanitizeToolUseId } from "../../utils/tool-id"
import type { ApiMessage } from "./apiMessages"

/** Completed and errored turns report to the parent; resumable interruption and cancellation do not. */
export const AGENT_RESULT_NOTIFICATION_STATUSES: readonly AgentLifecycleStatus[] = [
	"completed",
	"failed",
	"blocked",
	"timed_out",
]

export function isAgentResultNotification(entry: AgentMailboxEntry): boolean {
	return (
		entry.kind === "result" && AGENT_RESULT_NOTIFICATION_STATUSES.some((status) => entry.payload?.status === status)
	)
}

/** Stable model-facing envelope shared by automatic delivery and native wait receipts. */
export function serializeAgentNotification(entry: AgentMailboxEntry): string {
	return JSON.stringify({
		source: "managed_agent_notification",
		eventId: entry.eventId,
		sequence: entry.sequence,
		createdAt: entry.createdAt,
		senderTaskId: entry.senderTaskId,
		senderPath: entry.senderPath,
		recipientTaskId: entry.recipientTaskId,
		recipientPath: entry.recipientPath,
		kind: entry.kind,
		name: entry.name,
		payload: entry.payload,
	})
}

/** Body text alone is not a receipt: legacy wait delivery also needs its successful native tool result. */
export function getPersistedAgentNotificationIds(
	history: readonly ApiMessage[],
	expectedEntries: readonly AgentMailboxEntry[] = [],
	present: (text: string) => string = (text) => text,
): Set<string> {
	const eventIds = new Set<string>()
	const waitCallIds = new Set<string>()
	const expectedById = new Map(
		expectedEntries.map((entry) => [
			entry.eventId,
			JSON.parse(present(serializeAgentNotification(entry))) as unknown,
		]),
	)
	for (const message of history) {
		if (message.role === "user" && message.input_origin === "agent" && message.agent_message_id)
			eventIds.add(message.agent_message_id)
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue
		for (const block of message.content) {
			if (block.type === "tool_use" && block.name === "wait_agent") waitCallIds.add(sanitizeToolUseId(block.id))
		}
	}
	for (const message of history) {
		if (message.role !== "user" || !Array.isArray(message.content)) continue
		const hasReceipt = message.content.some((block) => {
			if (
				block.type !== "tool_result" ||
				block.is_error ||
				!waitCallIds.has(sanitizeToolUseId(block.tool_use_id))
			)
				return false
			const texts =
				typeof block.content === "string"
					? [block.content]
					: (block.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : []))
			return texts.some((text) => {
				try {
					const receipt = JSON.parse(text) as { source?: unknown; claimId?: unknown }
					return (
						receipt.source === "managed_agent_mailbox" &&
						typeof receipt.claimId === "string" &&
						receipt.claimId.length > 0
					)
				} catch {
					return false
				}
			})
		})
		if (!hasReceipt) continue
		for (const block of message.content) {
			if (block.type !== "text") continue
			try {
				const notification = JSON.parse(block.text) as Record<string, unknown>
				if (notification.source !== "managed_agent_notification" || typeof notification.eventId !== "string")
					continue
				const expected = expectedById.get(notification.eventId)
				if (!expected) continue
				// The receipt must identify the actual claimed input, not coincidental JSON prose.
				if (isDeepStrictEqual(notification, expected)) eventIds.add(notification.eventId)
			} catch {
				// Ordinary tool input is not a delivery receipt.
			}
		}
	}
	return eventIds
}
