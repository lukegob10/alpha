import { REDACTION_VERSION } from "./types"

const SENSITIVE_KEY = /authorization|cookie|credential|password|secret|token|api[-_]?key/i
const REDACTED = `[REDACTED:${REDACTION_VERSION}]`
const TOKEN_METRIC_KEYS = new Set([
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWriteTokens",
	"reasoningTokens",
	"tokensIn",
	"tokensOut",
	"promptTokens",
	"completionTokens",
	"totalTokens",
])

export type RedactionOptions = { secrets?: string[] }

export function redact(value: unknown, options: RedactionOptions = {}): unknown {
	const variants = secretVariants(options.secrets ?? [])
	return visit(value, variants)
}

export function containsSecret(value: unknown, secrets: string[]): boolean {
	const serialized = JSON.stringify(value) ?? ""
	return secretVariants(secrets).some(
		(secret) =>
			(typeof value === "string" && value.includes(secret)) ||
			serialized.includes(secret) ||
			serialized.includes(JSON.stringify(secret).slice(1, -1)),
	)
}

function visit(value: unknown, variants: string[]): unknown {
	if (typeof value === "string") return redactString(value, variants)
	if (value instanceof Uint8Array) {
		return new TextEncoder().encode(redactString(new TextDecoder().decode(value), variants))
	}
	if (Array.isArray(value)) return value.map((child) => visit(child, variants))
	if (value && typeof value === "object") {
		const usedKeys = new Set<string>()
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, child]) => {
				const redactedKey = redactString(key, variants)
				let safeKey = redactedKey
				let collision = 0
				// Several encoded forms of one credential may redact to the same key.
				// Preserve every observation instead of silently overwriting its value.
				while (usedKeys.has(safeKey)) safeKey = `${redactedKey}#${++collision}`
				usedKeys.add(safeKey)
				return [
					safeKey,
					SENSITIVE_KEY.test(key) &&
					!(
						TOKEN_METRIC_KEYS.has(key) &&
						(child === null || (typeof child === "number" && Number.isSafeInteger(child) && child >= 0))
					)
						? REDACTED
						: visit(child, variants),
				]
			}),
		)
	}
	return value
}

function redactString(value: string, variants: string[]): string {
	return variants.reduce((text, secret) => text.replaceAll(secret, REDACTED), value)
}

function secretVariants(secrets: string[]): string[] {
	return [
		...new Set(
			secrets.flatMap((secret) => [
				secret,
				JSON.stringify(secret).slice(1, -1),
				Buffer.from(secret).toString("base64"),
				encodeURIComponent(secret),
			]),
		),
	]
		.filter(Boolean)
		.sort((left, right) => right.length - left.length)
}
