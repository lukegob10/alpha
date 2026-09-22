export function unusedDebug(value) {
	return `DEBUG:${value}`
}

export function formatReport(items) {
	const total = items.reduce((sum, item) => sum + item.amount, 0)
	return `total=${total} ${unusedDebug(total)}`
}
