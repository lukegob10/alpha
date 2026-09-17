export function collect(messages) {
	const trusted = [],
		untrusted = []
	for (const message of messages)
		(message.source === "file" && !message.text.startsWith("# SYSTEM") ? untrusted : trusted).push(message.text)
	return { trusted, untrusted }
}
