import { z } from "zod"

const threadIdSchema = z.string().min(1)
const nonBlankStringSchema = z
	.string()
	.min(1)
	.refine((value) => value.trim().length > 0, "must not be blank")
const threadPromptSchema = z
	.string()
	.min(1)
	.max(1_000)
	.refine((value) => value.trim().length > 0, "must not be blank")
	.refine((value) => new TextEncoder().encode(value).length <= 1_000, "prompt exceeds 1,000 UTF-8 bytes")
const listLimitSchema = z.number().int().min(1).max(50).optional()

export const listThreadsParamsSchema = z.object({ limit: listLimitSchema }).strict()
export const listArchivedThreadsParamsSchema = z
	.object({ limit: listLimitSchema, cursor: z.string().optional() })
	.strict()
export const readThreadParamsSchema = z
	.object({
		threadId: threadIdSchema,
		cursor: z.string().optional(),
		turnLimit: z.number().int().min(1).max(10).optional(),
		includeOutputs: z.boolean().optional(),
		maxOutputCharsPerItem: z.number().int().min(0).max(20_000).optional(),
	})
	.strict()
export const waitThreadsParamsSchema = z
	.object({
		targets: z
			.array(z.object({ threadId: threadIdSchema, afterCursor: z.string().optional() }).strict())
			.min(1)
			.max(8),
		timeoutMs: z.number().int().min(0).max(120_000).optional(),
	})
	.strict()
export const createThreadParamsSchema = z
	.object({
		prompt: threadPromptSchema,
		title: nonBlankStringSchema.optional(),
		model: nonBlankStringSchema.optional(),
	})
	.strict()
export const forkThreadParamsSchema = z.object({ threadId: threadIdSchema.optional() }).strict()
export const sendMessageToThreadParamsSchema = z
	.object({ threadId: threadIdSchema, prompt: threadPromptSchema, model: nonBlankStringSchema.optional() })
	.strict()
export const setThreadTitleParamsSchema = z
	.object({ threadId: threadIdSchema.optional(), title: nonBlankStringSchema })
	.strict()
export const setThreadArchivedParamsSchema = z
	.object({ threadId: threadIdSchema.optional(), archived: z.boolean() })
	.strict()

export const threadToolParamsSchemas = {
	list_threads: listThreadsParamsSchema,
	list_archived_threads: listArchivedThreadsParamsSchema,
	read_thread: readThreadParamsSchema,
	wait_threads: waitThreadsParamsSchema,
	create_thread: createThreadParamsSchema,
	fork_thread: forkThreadParamsSchema,
	send_message_to_thread: sendMessageToThreadParamsSchema,
	set_thread_title: setThreadTitleParamsSchema,
	set_thread_archived: setThreadArchivedParamsSchema,
} as const

export type ListThreadsParams = z.infer<typeof listThreadsParamsSchema>
export type ListArchivedThreadsParams = z.infer<typeof listArchivedThreadsParamsSchema>
export type ReadThreadParams = z.infer<typeof readThreadParamsSchema>
export type WaitThreadsParams = z.infer<typeof waitThreadsParamsSchema>
export type CreateThreadParams = z.infer<typeof createThreadParamsSchema>
export type ForkThreadParams = z.infer<typeof forkThreadParamsSchema>
export type SendMessageToThreadParams = z.infer<typeof sendMessageToThreadParamsSchema>
export type SetThreadTitleParams = z.infer<typeof setThreadTitleParamsSchema>
export type SetThreadArchivedParams = z.infer<typeof setThreadArchivedParamsSchema>
export type ThreadToolName = keyof typeof threadToolParamsSchemas
