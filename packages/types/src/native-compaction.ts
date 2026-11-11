import { z } from "zod"

export const MAX_NATIVE_COMPACTION_CHARACTERS = 8 * 1024 * 1024
const MAX_NATIVE_COMPACTION_ITEMS = 256

/** A native window is opaque provider input. Its retained items must stay in their original order. */
const checkpointShape = z
	.object({
		protocol: z.literal("openai-responses"),
		provider: z.literal("openai-native"),
		modelId: z.string().min(1).max(1_024),
		responseId: z.string().min(1).max(1_024),
		output: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_NATIVE_COMPACTION_ITEMS),
	})
	.strict()
	.superRefine((checkpoint, context) => {
		let compactionItems = 0
		for (const item of checkpoint.output) {
			if (typeof item.type !== "string" || item.type.length === 0 || item.type.length > 128) {
				context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid native compaction item type" })
				return
			}
			if (item.type === "compaction") {
				compactionItems++
				if (typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0) {
					context.addIssue({ code: z.ZodIssueCode.custom, message: "Missing encrypted compaction content" })
					return
				}
			}
		}
		if (compactionItems !== 1) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid or oversized native compaction window" })
		}
	})

export const nativeCompactionCheckpointSchema = z.preprocess(
	(value) => (isBoundedJson(value) ? value : undefined),
	checkpointShape,
)

export type NativeCompactionCheckpoint = z.infer<typeof nativeCompactionCheckpointSchema>
export type NativeCompactionScope = Pick<NativeCompactionCheckpoint, "provider" | "modelId">

/** Bound depth, traversal, and payload before serializing untrusted provider or persisted data. */
function isBoundedJson(value: unknown): boolean {
	const pending = [{ value, depth: 0 }]
	const seen = new Set<object>()
	let remainingCharacters = MAX_NATIVE_COMPACTION_CHARACTERS
	let remainingNodes = 100_000
	while (pending.length > 0) {
		const current = pending.pop()!
		if (--remainingNodes < 0 || current.depth > 32) return false
		if (typeof current.value === "string") {
			remainingCharacters -= current.value.length
		} else if (typeof current.value === "number") {
			if (!Number.isFinite(current.value)) return false
		} else if (typeof current.value === "object" && current.value !== null) {
			if (seen.has(current.value)) return false
			const prototype = Object.getPrototypeOf(current.value)
			if (!Array.isArray(current.value) && prototype !== Object.prototype && prototype !== null) return false
			if (Array.isArray(current.value) && current.value.length > remainingNodes) return false
			seen.add(current.value)
			const descriptors = Object.getOwnPropertyDescriptors(current.value)
			if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) return false
			const entries = Object.entries(current.value)
			if (entries.length > remainingNodes) return false
			for (const [key, child] of entries) {
				remainingCharacters -= key.length
				pending.push({ value: child, depth: current.depth + 1 })
			}
		} else if (current.value !== null && typeof current.value !== "boolean") {
			return false
		}
		if (remainingCharacters < 0) return false
	}
	try {
		return JSON.stringify(value).length <= MAX_NATIVE_COMPACTION_CHARACTERS
	} catch {
		return false
	}
}

/** Copy only validated JSON; callers never retain the provider's mutable response objects. */
export function snapshotNativeCompactionCheckpoint(value: unknown): NativeCompactionCheckpoint | undefined {
	const parsed = nativeCompactionCheckpointSchema.safeParse(value)
	if (!parsed.success) return undefined
	return JSON.parse(JSON.stringify(parsed.data)) as NativeCompactionCheckpoint
}
