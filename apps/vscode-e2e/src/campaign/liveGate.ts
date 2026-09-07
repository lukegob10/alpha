import * as fs from "node:fs/promises"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"

import { WORKFLOW_SCENARIO_IDS } from "../scenarios/contracts"
import { rejectSymlinkComponents } from "../evidence/paths"
import { runOwnedProcess } from "./ownedProcess"
import type { CampaignConfig, CampaignReport } from "./types"

export function assertLiveGateConfig(config: CampaignConfig): void {
	if (
		config.provider.mode !== "live-copilot" ||
		!config.provider.modelId ||
		!config.provider.effort ||
		config.repair ||
		config.scenarioIds.length !== WORKFLOW_SCENARIO_IDS.length ||
		WORKFLOW_SCENARIO_IDS.some((id) => !config.scenarioIds.includes(id))
	)
		throw new Error("Live gate requires the complete development suite, exact live model/effort, and no repair")
}

/** Count every required cell independently; aggregate counters and a later retry cannot manufacture acceptance. */
export function evaluateLiveGate(config: CampaignConfig, report: CampaignReport) {
	assertLiveGateConfig(config)
	const cells = config.hosts.flatMap((host) =>
		config.scenarioIds.flatMap((scenarioId) =>
			Array.from({ length: config.samples }, (_, index) => {
				const sample = index + 1
				const attempts = report.attempts.filter(
					(attempt) =>
						attempt.request.host.version === host.version &&
						attempt.request.scenarioId === scenarioId &&
						attempt.request.sample === sample,
				)
				const valid = attempts.every(
					({ request, result, evidence, evidenceFailed }) =>
						request.campaignId === config.id &&
						request.phase === "sample" &&
						request.provider.mode === "live-copilot" &&
						request.provider.modelId === config.provider.modelId &&
						request.provider.effort === config.provider.effort &&
						result.status === "passed" &&
						!result.failure &&
						!result.retentionFailed &&
						result.actualHostVersion === host.version &&
						result.model?.id === config.provider.modelId &&
						result.model?.effort === config.provider.effort &&
						Number.isSafeInteger(result.usage.requests) &&
						result.usage.requests! > 0 &&
						Boolean(result.taskIds?.length) &&
						Boolean(evidence) &&
						!evidenceFailed,
				)
				return {
					hostVersion: host.version,
					scenarioId,
					sample,
					status:
						attempts.length === 0
							? "not-run"
							: valid && attempts.filter((attempt) => attempt.request.phase === "sample").length === 1
								? "passed"
								: "failed",
					attemptIds: attempts.map((attempt) => attempt.request.attemptId),
				}
			}),
		),
	)
	const attemptsAccountedFor = cells.reduce((sum, cell) => sum + cell.attemptIds.length, 0) === report.attempts.length
	const passed =
		report.id === config.id &&
		report.mode === "report-only" &&
		report.requestedProvider.mode === "live-copilot" &&
		report.requestedProvider.modelId === config.provider.modelId &&
		report.requestedProvider.effort === config.provider.effort &&
		Boolean(report.finishedAt) &&
		report.stopReason === "completed" &&
		report.retention?.status === "complete" &&
		report.counts.failed === 0 &&
		report.counts.blocked === 0 &&
		report.counts.passed === report.attempts.length &&
		report.usage.requests ===
			report.attempts.reduce((sum, attempt) => sum + (attempt.result.usage.requests ?? 0), 0) &&
		new Set(report.attempts.map((attempt) => attempt.request.attemptId)).size === report.attempts.length &&
		attemptsAccountedFor &&
		cells.length > 0 &&
		cells.every((cell) => cell.status === "passed")
	return {
		schemaVersion: 1,
		kind: "alpha-live-development-gate",
		campaignId: config.id,
		scope: config.hosts.length === 2 ? "reference-and-current-hosts" : "single-host-only",
		status: passed ? "passed" : "failed",
		stopReason: report.stopReason ?? "incomplete",
		retention: report.retention ?? null,
		counts: report.counts,
		provider: config.provider,
		cells,
	} as const
}

/** Fingerprint the entrypoint, webview and harness bytes actually used; a watcher rebuild invalidates this run. */
export async function fingerprintGateArtifacts(repositoryRoot: string): Promise<string> {
	const hash = createHash("sha256")
	let entries = 0
	let bytes = 0
	const visit = async (relative: string): Promise<void> => {
		if (++entries > 10_000) throw new Error("Gate artifact entry limit")
		const absolute = path.join(repositoryRoot, relative)
		await rejectSymlinkComponents(absolute)
		const stat = await fs.lstat(absolute)
		hash.update(relative.replace(/\\/g, "/") + "\0")
		if (stat.isDirectory()) {
			for (const name of (await fs.readdir(absolute)).sort()) await visit(path.join(relative, name))
		} else if (stat.isFile()) {
			bytes += stat.size
			if (bytes > 512 * 1024 * 1024) throw new Error("Gate artifact byte limit")
			hash.update(String(stat.size) + "\0")
			for await (const chunk of createReadStream(absolute)) hash.update(chunk)
		} else throw new Error("Invalid gate artifact")
	}
	for (const relative of ["src/package.json", "src/dist/extension.js", "src/webview-ui/build", "apps/vscode-e2e/out"])
		await visit(relative)
	return hash.digest("hex")
}

/** Builds and exact-host contracts run before paid requests. Uses existing pnpm scripts and owned-process cleanup. */
export async function prepareLiveGate(
	repositoryRoot: string,
	pnpmCliPath: string | undefined,
	runDirectory: string,
	signal: AbortSignal,
	runProcess = runOwnedProcess,
): Promise<boolean> {
	if (!pnpmCliPath || !path.isAbsolute(pnpmCliPath)) throw new Error("Run the live gate through pnpm")
	for (const script of ["test:unit", "test:smoke:1221"]) {
		signal.throwIfAborted()
		process.stdout.write(`Live gate prerequisite: ${script}\n`)
		const abort = new AbortController()
		const cancel = () => abort.abort()
		signal.addEventListener("abort", cancel, { once: true })
		const timer = setTimeout(cancel, 10 * 60 * 1_000)
		try {
			const result = await runProcess(
				{
					executable: process.execPath,
					args: [pnpmCliPath, "--dir", "apps/vscode-e2e", script],
					cwd: repositoryRoot,
				},
				{ signal: abort.signal },
			)
			await fs.writeFile(
				path.join(runDirectory, `prepare-${script.replaceAll(":", "-")}.json`),
				JSON.stringify({ script, ...result }) + "\n",
				{ flag: "wx", mode: 0o600 },
			)
			if (abort.signal.aborted || result.exitCode !== 0 || result.signal !== null) return false
		} finally {
			clearTimeout(timer)
			signal.removeEventListener("abort", cancel)
		}
	}
	return true
}
