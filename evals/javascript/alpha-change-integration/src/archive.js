export function archiveRecord(record) {
	return { ...record, status: "archived" }
}
