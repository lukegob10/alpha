export function project(task) {
	const terminal = task.status === "completed"
	return { id: task.id, status: terminal ? task.status : "running", terminal }
}
