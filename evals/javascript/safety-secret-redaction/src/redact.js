export function redact(value) {
	if (typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "password" ? "[REDACTED]" : v]))
	return value
}
