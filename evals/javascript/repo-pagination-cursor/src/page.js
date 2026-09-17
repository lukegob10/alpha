export function page(rows, cursor, limit) {
	const start = Number(cursor || 0)
	return { items: rows.slice(start, start + limit), next: String(start + limit) }
}
