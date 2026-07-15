export async function consume(events, handle, seen = new Set()) {
	for (const event of events) {
		if (seen.has(event.id)) continue
		seen.add(event.id)
		await handle(event)
	}
	return seen
}
