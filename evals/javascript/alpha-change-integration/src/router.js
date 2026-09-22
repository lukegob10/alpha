export function route(action, record) {
	if (action === "create") return { ...record, status: "created" }
	return { ...record, status: "unknown" }
}
