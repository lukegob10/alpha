import { z } from "zod"

export const persistentCommandPrefixAmendmentSchema = z
	.object({
		kind: z.literal("command_prefix"),
		prefix: z
			.string()
			.min(1)
			.max(4096)
			.regex(/^[A-Za-z0-9_./\\:=,+-]+(?:[ \t]+[A-Za-z0-9_./\\:=,+-]+)*$/),
	})
	.strict()

export const exactCommandApprovalAmendmentSchema = z
	.object({
		kind: z.literal("exact_command"),
		command: z.string().min(1).max(4096),
	})
	.strict()

/** Approval amendments can keep an exact request in-session or save a reviewed command prefix. */
export const toolApprovalAmendmentSchema = z.discriminatedUnion("kind", [
	exactCommandApprovalAmendmentSchema,
	persistentCommandPrefixAmendmentSchema,
])

export type PersistentCommandPrefixAmendment = z.infer<typeof persistentCommandPrefixAmendmentSchema>
export type ToolApprovalAmendment = z.infer<typeof toolApprovalAmendmentSchema>
