export async function exportRecords(records, write, { concurrency = 2, signal } = {}) {
	return Promise.all(records.map((record) => write(record, signal)))
}
