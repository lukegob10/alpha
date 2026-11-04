/**
 * Strict OpenAI functions encode omitted optional values as null (official function-calling
 * strict-mode contract, retrieved 2026-10-31). Null clears in the saved/UI ticket contract
 * remain meaningful; normalize only listing omissions at the model tool boundary.
 */
export function normalizeTicketToolArguments(name: string, args: unknown): unknown {
	if (name !== "list_tickets" || typeof args !== "object" || args === null || Array.isArray(args)) return args
	const input = args as Record<string, unknown>
	const normalized = { ...input }
	if (Object.prototype.hasOwnProperty.call(input, "typeFilter")) {
		if (Object.prototype.hasOwnProperty.call(input, "type"))
			throw new Error("Use typeFilter or the legacy type filter, not both")
		delete normalized.typeFilter
		if (input.typeFilter !== null && input.typeFilter !== undefined)
			normalized.type = input.typeFilter === "untagged" ? null : input.typeFilter
	}
	for (const field of ["query", "status", "offset", "limit"]) if (normalized[field] === null) delete normalized[field]
	return normalized
}
