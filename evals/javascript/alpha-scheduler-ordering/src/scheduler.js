export function restore(rows) {
	return rows.sort((a, b) => a.at - b.at)
}
