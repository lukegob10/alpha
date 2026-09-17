export function cancelRun(run) {
	run.state = "cancelled"
	run.timer = null
	return run
}
