export function validatedAfterLastEdit(events) {
	return events.some((e) => e.type === "test" && e.ok)
}
