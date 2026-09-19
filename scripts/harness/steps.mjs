import { tsImport } from "tsx/esm/api"

// Use the host runner's existing process owner directly; no generated build is needed to run local checks.
const { pnpmCommand, runOwnedProcess } = await tsImport(
	"../../apps/vscode-e2e/src/campaign/ownedProcess.ts",
	import.meta.url,
)

export async function executeSteps({ commands, root, pnpmPath, report, signal, save, runProcess = runOwnedProcess }) {
	for (const [index, args] of commands.entries()) {
		if (signal.aborted) break
		const step = report.steps[index]
		step.status = "running"
		step.startedAt = new Date().toISOString()
		await save(report)
		try {
			const result = await runProcess(
				{
					...pnpmCommand(pnpmPath, args),
					cwd: root,
					env: {
						...process.env,
						VITEST_MAX_FORKS: "2",
						VITEST_MIN_FORKS: "1",
						VITEST_MAX_THREADS: "2",
						VITEST_MIN_THREADS: "1",
					},
				},
				{ output: "inherit", signal },
			)
			step.exitCode = result.exitCode
			step.signal = result.signal
			step.cleanupVerified = result.cleanupVerified
			step.status = signal.aborted
				? "cancelled"
				: result.exitCode === 0 && result.signal === null
					? "passed"
					: "failed"
			if ((signal.aborted || result.signal !== null) && !result.cleanupVerified) report.cleanupUnverified = true
		} catch (error) {
			step.status = signal.aborted ? "cancelled" : "failed"
			step.error = error?.cleanupVerified === false ? "cleanup_failed" : "process_failed"
			if (signal.aborted || error?.cleanupVerified === false) report.cleanupUnverified = true
		}
		step.finishedAt = new Date().toISOString()
		await save(report)
		if (step.status !== "passed") break
	}
	report.status = signal.aborted
		? "cancelled"
		: report.steps.every((step) => step.status === "passed")
			? "passed"
			: "failed"
	report.finishedAt = new Date().toISOString()
	await save(report)
}
