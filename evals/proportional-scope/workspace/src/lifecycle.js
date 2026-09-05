export function transition(task, event) {
	if (task.status === "completed") return task
	if (event === "start") return { ...task, status: "running" }
	if (event === "complete") return { ...task, status: "completed" }
	if (event === "cancel") return { ...task, status: "cancelled" }
	return task
}
