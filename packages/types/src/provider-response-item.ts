import { z } from "zod"

const MAX_METADATA_CHARACTERS = 32_768

/** Reject oversized/non-JSON metadata before schema parsing or snapshotting allocates a second copy. */
function isBoundedJson(value: unknown): boolean {
	let nodes = 4_096
	let characters = MAX_METADATA_CHARACTERS
	const ancestors = new Set<object>()
	const visit = (item: unknown, depth: number): boolean => {
		if (--nodes < 0 || depth > 12) return false
		if (typeof item === "string") return (characters -= item.length) >= 0
		if (item === null || typeof item === "boolean") return true
		if (typeof item === "number") return Number.isFinite(item)
		if (typeof item !== "object" || ancestors.has(item)) return false
		if (
			!Array.isArray(item) &&
			Object.getPrototypeOf(item) !== Object.prototype &&
			Object.getPrototypeOf(item) !== null
		) {
			return false
		}
		const entries = Array.isArray(item) ? item : Object.entries(item)
		if (entries.length > 256) return false
		ancestors.add(item)
		const valid = entries.every((entry) => {
			if (Array.isArray(item)) return visit(entry, depth + 1)
			const [key, child] = entry as [string, unknown]
			characters -= key.length
			return characters >= 0 && visit(child, depth + 1)
		})
		ancestors.delete(item)
		return valid
	}
	return visit(value, 0)
}

/** Source metadata only: tool names, arguments and approval authority remain canonical host fields. */
export const providerResponseItemSchema = z.preprocess(
	(value) => (isBoundedJson(value) ? value : undefined),
	z.object({
		protocol: z.literal("openai-responses"),
		providerId: z.string().min(1).max(128),
		modelId: z.string().min(1).max(1_024),
		itemType: z.enum(["message", "function_call", "custom_tool_call"]),
		id: z.string().min(1).max(1_024).optional(),
		status: z.enum(["in_progress", "completed", "incomplete"]).optional(),
		namespace: z.string().min(1).max(128).optional(),
		content: z
			.array(
				z.object({
					type: z.enum(["output_text", "refusal"]),
					/** Length identifies the original part without duplicating sampled text in metadata. */
					length: z.number().int().nonnegative().safe(),
					annotations: z.array(z.unknown()).max(256).optional(),
					logprobs: z.array(z.unknown()).max(256).optional(),
				}),
			)
			.max(128)
			.optional(),
	}),
)
export type ProviderResponseItem = z.infer<typeof providerResponseItemSchema>

/** Unknown/oversized optional metadata cannot invalidate otherwise usable model output. */
export function snapshotProviderResponseItem(value: unknown): ProviderResponseItem | undefined {
	const result = providerResponseItemSchema.safeParse(value)
	if (!result.success) return undefined
	const json = JSON.stringify(result.data)
	return json.length <= MAX_METADATA_CHARACTERS ? (JSON.parse(json) as ProviderResponseItem) : undefined
}
