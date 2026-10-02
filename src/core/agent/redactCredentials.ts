const REDACTED_VALUE = "[redacted]"

/** Redact diagnostic text before either agent journal bounds or persists it. */
export function redactAgentCredentialText(value: string): string {
	let redacted = value.replace(
		/(\b(?:Proxy-)?Authorization\b["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n]+)/gi,
		(_match, prefix: string, authorization: string) => {
			// Authentication schemes can carry multiple comma-separated parameters.
			// Redact the full field; retaining only Bearer preserves old diagnostics
			// without mistaking an arbitrary credential for an authentication scheme.
			const bearer = /^Bearer[ \t]+/i.exec(authorization)?.[0] ?? ""
			return `${prefix}${bearer}${REDACTED_VALUE}`
		},
	)
	redacted = redacted.replace(
		/(\b(?:api.?key|access.?key|client.?secret|secret|password|passwd|credential|private.?key|(?:(?:auth|access|refresh|id).?)?token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi,
		`$1${REDACTED_VALUE}`,
	)
	redacted = redacted.replace(/(\bBearer\s+)(?!\[redacted\])[^\s,;}\]]+/gi, `$1${REDACTED_VALUE}`)
	redacted = redacted.replace(
		/([?&](?:api.?key|access.?key|secret|password|credential|authorization|(?:(?:auth|access|refresh|id).?)?token)=)[^&#\s]+/gi,
		`$1${REDACTED_VALUE}`,
	)
	return redacted
}
