import * as path from "path"
import * as fs from "fs/promises"
import crypto from "crypto"

import { Anthropic } from "@anthropic-ai/sdk"
import type { TaskGoalUsageReceipt } from "@alpha-code/types"

import { fileExistsAtPath } from "../../utils/fs"

import { GlobalFileNames } from "../../shared/globalFileNames"
import { getTaskDirectoryPath } from "../../utils/storage"
import type { CompletionHookPromptProvenance } from "../agent/CompletionHooks"
import type { AgentResponseItem, AgentResponseOutcome } from "../agent/AgentResponse"
import type { AssistantMessagePhase } from "@alpha-code/types"
import { atomicWriteText, withFileLock } from "./atomicWrite"
import { invalidPersistedApiMessages } from "./validatePersistedApiMessages"
import {
	assertAuthoritativeTranscriptMissing,
	assertAuthoritativeTranscriptReplacementAllowed,
	ProviderTranscriptStoreError,
	serializeProviderTranscript,
	withLegacyTranscriptMigration,
} from "./ProviderTranscriptStore"

/** Receipt for the exact canonical bytes written by the authoritative writer. */
export interface ApiMessagesCommitReceipt {
	taskId: string
	filePath: string
	digest: string
	byteLength: number
	commitId: string
}

export type ApiMessage = Anthropic.MessageParam & {
	/** Host-authored provenance; provider role alone does not establish human intent. */
	input_origin?: "human" | "agent"
	/** Accepted human queue entries durably incorporated into this user/tool-input boundary. */
	queued_message_ids?: string[]
	/** Host receipt for agent inbox delivery; never human approval or a provider response ID. */
	agent_message_id?: string
	/** Host-owned source of a hook continuation; retained in the canonical transcript across reload. */
	hook_prompt?: CompletionHookPromptProvenance
	/** Goal usage persisted before charging its owner; replay closes a crash between the two writes. */
	goal_usage_receipts?: TaskGoalUsageReceipt[]
	ts?: number
	isSummary?: boolean
	/** Legacy response receipt (or standalone reasoning ID); never an assistant output-message ID. */
	id?: string
	/** Optional original assistant message identity for a single-message envelope. */
	messageId?: string
	/** Original assistant message classification; absent for legacy or unsupported providers. */
	phase?: AssistantMessagePhase
	/** Ordered canonical response evidence retained across persistence and context projection. */
	agentResponseItems?: AgentResponseItem[]
	agentResponseOutcome?: AgentResponseOutcome
	// For reasoning items stored in API history
	type?: "reasoning"
	summary?: any[]
	encrypted_content?: string
	text?: string
	// For OpenRouter reasoning_details array format (used by Gemini 3, etc.)
	reasoning_details?: any[]
	// For DeepSeek/Z.ai interleaved thinking: reasoning_content that must be preserved during tool call sequences
	// See: https://api-docs.deepseek.com/guides/thinking_mode#tool-calls
	reasoning_content?: string
	// For non-destructive condense: unique identifier for summary messages
	condenseId?: string
	// For non-destructive condense: points to the condenseId of the summary that replaces this message
	// Messages with condenseParent are filtered out when sending to API if the summary exists
	condenseParent?: string
	/** Producing summary for a carried user copy; removing that summary removes this copy. */
	condenseCopyParent?: string
	// For non-destructive truncation: unique identifier for truncation marker messages
	truncationId?: string
	// For non-destructive truncation: points to the truncationId of the marker that hides this message
	// Messages with truncationParent are filtered out when sending to API if the marker exists
	truncationParent?: string
	// Identifies a message as a truncation boundary marker
	isTruncationMarker?: boolean
}

export async function readApiMessages({
	taskId,
	globalStoragePath,
}: {
	taskId: string
	globalStoragePath: string
}): Promise<ApiMessage[]> {
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.apiConversationHistory)

	if (await fileExistsAtPath(filePath)) {
		const fileContent = await fs.readFile(filePath, "utf8")
		let parsedData: unknown
		try {
			parsedData = JSON.parse(fileContent)
		} catch (error) {
			throw new ProviderTranscriptStoreError(
				"invalid_messages",
				"Invalid API conversation history JSON",
				taskId,
				{
					cause: error,
				},
			)
		}
		assertValidHistory(parsedData, taskId)
		return parsedData
	} else {
		return withLegacyTranscriptMigration(filePath, taskId, async (existingAuthority) => {
			if (existingAuthority !== undefined) return existingAuthority
			const oldPath = path.join(taskDir, "claude_messages.json")

			if (await fileExistsAtPath(oldPath)) {
				const fileContent = await fs.readFile(oldPath, "utf8")
				let parsedData: unknown
				try {
					parsedData = JSON.parse(fileContent)
				} catch (error) {
					throw new ProviderTranscriptStoreError(
						"invalid_messages",
						"Invalid legacy API conversation history JSON",
						taskId,
						{
							cause: error,
						},
					)
				}
				assertValidHistory(parsedData, taskId)
				try {
					// Commit the replacement before removing the fallback. resumeTaskFromHistory
					// reads twice, so deleting the only durable copy here loses the task.
					await writeApiMessages({ messages: parsedData, taskId, globalStoragePath, onlyIfMissing: true })
					await fs.unlink(oldPath)
				} catch (error) {
					// An admission conflict is not permission to serve an obsolete prefix.
					if (error instanceof ProviderTranscriptStoreError) throw error
					// Keep serving the parsed fallback and retain whichever durable copy
					// remains. A later read can safely retry the idempotent migration.
					console.warn(
						`[readApiMessages] Failed to migrate OLD API conversation history file. TaskId: ${taskId}, Old path: ${oldPath}, New path: ${filePath}, Error: ${error}`,
					)
				}

				return parsedData
			}
			return []
		})
	}
}

function assertValidHistory(value: unknown, taskId: string): asserts value is ApiMessage[] {
	const problem = invalidPersistedApiMessages(value)
	if (problem) {
		throw new ProviderTranscriptStoreError(
			"invalid_messages",
			`Invalid API conversation history: ${problem}`,
			taskId,
		)
	}
}

export async function saveApiMessages(input: {
	messages: ApiMessage[]
	taskId: string
	globalStoragePath: string
}): Promise<ApiMessagesCommitReceipt> {
	return writeApiMessages(input)
}

async function writeApiMessages({
	messages,
	taskId,
	globalStoragePath,
	onlyIfMissing = false,
}: {
	messages: ApiMessage[]
	taskId: string
	globalStoragePath: string
	onlyIfMissing?: boolean
}): Promise<ApiMessagesCommitReceipt> {
	// Serialize before awaiting: caller mutation during filesystem I/O cannot
	// change either the intended snapshot or its receipt. Canonical bytes match
	// the existing in-memory digest fence, including unknown provider metadata.
	const contents = serializeProviderTranscript(messages)
	const digest = crypto.createHash("sha256").update(contents).digest("hex")
	const byteLength = Buffer.byteLength(contents)
	const commitId = crypto.randomUUID()
	const taskDir = await getTaskDirectoryPath(globalStoragePath, taskId)
	const filePath = path.join(taskDir, GlobalFileNames.apiConversationHistory)
	await withFileLock(filePath, async () => {
		// Check inside the lock: a verifier may have detected a conflict while
		// this writer was already queued. All Task generations share this guard.
		assertAuthoritativeTranscriptReplacementAllowed(filePath)
		if (onlyIfMissing) await assertAuthoritativeTranscriptMissing(filePath, taskId)
		await atomicWriteText(filePath, contents, { requireAtomicReplace: true })
	})
	return Object.freeze({ taskId, filePath: path.resolve(filePath), digest, byteLength, commitId })
}
