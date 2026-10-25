import { applyAttemptEvent, findTrialForTask } from "../db/index"
import { DockerCliAdapter, reconcileOrphanedAttempts, type OpenAttempt } from "../infrastructure/index"
import { ExecaHarnessProcessRunner, type HarnessProcessRunner } from "../orchestration/index"

export async function reconcileRunBeforeDispatch(options: {
	runId: number
	taskIds: number[]
	containerized: boolean
	assertOwnership(): Promise<void>
	processRunner?: HarnessProcessRunner
}): Promise<void> {
	const open: Array<OpenAttempt & { version: number }> = []
	for (const taskId of options.taskIds) {
		const trial = await findTrialForTask(taskId)
		for (const attempt of trial?.attempts ?? []) {
			if (!attempt.terminalStatus) {
				open.push({
					databaseId: attempt.id,
					runId: String(options.runId),
					trialId: String(trial!.id),
					attemptId: String(attempt.id),
					leaseActive: false,
					version: attempt.version,
				})
			}
		}
	}
	if (!open.length) return
	await options.assertOwnership()
	if (!options.containerized)
		throw new Error("Interrupted local evaluation attempts require owned host cleanup before resuming")
	const docker = new DockerCliAdapter(options.processRunner ?? new ExecaHarnessProcessRunner())
	for (const attempt of open) {
		await options.assertOwnership()
		await docker.cleanup(attempt)
	}
	await reconcileOrphanedAttempts({
		listOpenAttempts: async () => open,
		listContainerAttemptIds: async (runId) =>
			(await docker.list({ runId })).map(({ labels }) => labels["alpha.evals.attempt-id"]!),
		markOrphaned: async (attemptId, detail) => {
			await options.assertOwnership()
			const attempt = open.find(({ databaseId }) => databaseId === attemptId)!
			await applyAttemptEvent(
				attemptId,
				{ type: "reconcile_interrupted", failureCode: "controller_interrupted", failureDetail: detail },
				{ expectedVersion: attempt.version },
			)
		},
	})
}
