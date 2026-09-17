import { REDACTION_VERSION } from "./types"

const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|token|api[-_]?key/i
const REDACTED = `[REDACTED:${REDACTION_VERSION}]`

export type RedactionOptions = { secrets?: string[] }

export function redact(value: unknown, options: RedactionOptions = {}): unknown {
	const variants = secretVariants(options.secrets ?? [])
	return visit(value, variants)
}

export function containsSecret(value: unknown, secrets: string[]): boolean {
	const serialized = JSON.stringify(value)
	return secretVariants(secrets).some((secret) => secret.length > 0 && serialized.includes(secret))
}

function visit(value: unknown, variants: string[]): unknown {
	if (typeof value === "string") return variants.reduce((text, secret) => text.replaceAll(secret, REDACTED), value)
	if (value instanceof Uint8Array) {
		return new TextEncoder().encode(
			variants.reduce((text, secret) => text.replaceAll(secret, REDACTED), new TextDecoder().decode(value)),
		)
	}
	if (Array.isArray(value)) return value.map((child) => visit(child, variants))
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, child]) => [
				key,
				SENSITIVE_KEY.test(key) ? REDACTED : visit(child, variants),
			]),
		)
	}
	return value
}

function secretVariants(secrets: string[]): string[] {
	return [
		...new Set(
			secrets.flatMap((secret) => [secret, Buffer.from(secret).toString("base64"), encodeURIComponent(secret)]),
		),
	]
		.filter(Boolean)
		.sort((left, right) => right.length - left.length)
}
