export function runWorkflow(records) {
	const total = records.reduce((sum, record) => sum + record.amount, 0)
	return { kept: records.length, total, skill: "ad-hoc" }
}
