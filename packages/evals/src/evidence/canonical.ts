import crypto from "crypto"

export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortValue(value))
}

export function sha256(value: string | Uint8Array): string {
	return `sha256:${crypto.createHash("sha256").update(value).digest("hex")}`
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue)
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, sortValue(child)]),
		)
	}
	return value
}
