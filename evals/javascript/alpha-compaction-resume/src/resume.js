export function resume(checkpoint) {
	return { completed: [], pending: checkpoint.steps, next: checkpoint.steps[0] }
}
