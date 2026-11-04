import * as fs from "node:fs/promises"
import * as path from "node:path"
import { createRequire } from "node:module"
import { randomUUID } from "node:crypto"
import * as os from "node:os"
import { isProviderName } from "@alpha-code/types"

import { runExtensionTests } from "./runTest"
import { fingerprintArtifactPaths } from "./campaign/liveGate"
import { readBounded } from "./evidence/paths"
import { prepareLiveSidecar } from "./liveHostProtocol"
import { LIVE_QUALITY_CASES, qualityDigest, qualityWorkCounters, type QualityCall } from "./quality/liveQuality"

export interface QualityCaptureOptions {
	label: "baseline" | "candidate"
	provider: "live" | "live-copilot"
	savedProvider?: string
	modelId: string
	effort: string
	profileDir: string
	output: string
	samples: number
	extensionDevelopmentPath?: string
}

/** A capture selects one real route; multiple captures form the cross-provider comparison. */
export function readQualityCaptureOptions(args: string[]): QualityCaptureOptions {
	if (args[0] !== "capture")
		throw new Error("Expected capture with explicit provider, model, effort, profile and output")
	const values = new Map<string, string>()
	const allowed = new Set([
		"label",
		"provider",
		"saved-provider",
		"model-id",
		"effort",
		"profile-dir",
		"output",
		"samples",
		"extension-development-path",
	])
	for (let index = 1; index < args.length; index += 2) {
		const key = args[index]?.slice(2)
		const value = args[index + 1]
		if (
			!args[index]?.startsWith("--") ||
			!key ||
			!allowed.has(key) ||
			values.has(key) ||
			!value ||
			value.startsWith("--")
		)
			throw new Error("Invalid or duplicate quality capture option")
		values.set(key, value)
	}
	const label = values.get("label")
	const provider = values.get("provider")
	const modelId = values.get("model-id")?.trim()
	const effort = values.get("effort")?.trim()
	const profileDir = values.get("profile-dir")
	const output = values.get("output")
	const savedProvider = values.get("saved-provider")
	const extensionDevelopmentPath = values.get("extension-development-path")
	const samples = Number(values.get("samples") ?? "3")
	if (
		!["baseline", "candidate"].includes(label ?? "") ||
		!["live", "live-copilot"].includes(provider ?? "") ||
		!modelId ||
		!effort ||
		!profileDir ||
		!path.isAbsolute(profileDir) ||
		!output ||
		!path.isAbsolute(output) ||
		!Number.isSafeInteger(samples) ||
		samples < 3 ||
		samples > 20 ||
		(extensionDevelopmentPath !== undefined && !path.isAbsolute(extensionDevelopmentPath)) ||
		(provider === "live"
			? !isProviderName(savedProvider) || savedProvider === "vscode-lm"
			: savedProvider !== undefined)
	)
		throw new Error(
			"Quality capture requires baseline/candidate, a real provider, exact model/effort, absolute paths and 3–20 samples",
		)
	return {
		label: label as QualityCaptureOptions["label"],
		provider: provider as QualityCaptureOptions["provider"],
		savedProvider,
		modelId,
		effort,
		profileDir,
		output,
		samples,
		extensionDevelopmentPath,
	}
}

type BuildProof = {
	status: string
	sourceTreeState: string
	manifestDigest?: string
	sourceRevision?: string
	sourceTreeDigest?: string
	artifactTreeDigest?: string
}

export async function captureQuality(options: QualityCaptureOptions): Promise<void> {
	const root = path.resolve(__dirname, "../../..")
	const extensionPath = options.extensionDevelopmentPath ?? path.join(root, "src")
	const sourceRoot = path.dirname(extensionPath)
	const verifier = createRequire(__filename)(path.join(root, "scripts/extension-build-provenance.mjs")) as {
		verifyExtensionBuildProvenance(input: {
			extensionPath: string
			repositoryRoot: string
			requireCleanSource: true
		}): Promise<BuildProof>
	}
	const verifyBuild = () =>
		verifier.verifyExtensionBuildProvenance({ extensionPath, repositoryRoot: sourceRoot, requireCleanSource: true })
	const before = await verifyBuild()
	if (before.status !== "verified" || before.sourceTreeState !== "clean" || !before.manifestDigest)
		throw new Error(
			"Quality capture requires a verified clean build matching the current source; build explicitly before capture",
		)
	if (options.provider === "live-copilot") await prepareLiveSidecar()
	const harnessDigest = await fingerprintArtifactPaths(root, ["apps/vscode-e2e/out"])
	const run = {
		schemaVersion: 1,
		kind: "alpha-live-short-task-quality",
		measurementKind: "real-extension-live",
		label: options.label,
		status: "running",
		declared: { provider: options.savedProvider ?? "vscode-lm", modelId: options.modelId, effort: options.effort },
		conditions: {
			hostVersion: "1.141.0",
			node: process.version,
			platform: process.platform,
			arch: process.arch,
			machineDigest: qualityDigest({
				cpuModels: os.cpus().map(({ model }) => model),
				memory: os.totalmem(),
				osRelease: os.release(),
			}),
			harnessDigest,
			fixtureDigest: qualityDigest(LIVE_QUALITY_CASES),
			fixtureIds: LIVE_QUALITY_CASES.map(({ id }) => id),
			cacheProtocol: "new-task-per-case;fresh-workspace-per-sample;provider-cache-uncontrolled",
		},
		build: before,
		samples: options.samples,
		observations: [] as Array<Record<string, unknown>>,
		failure: undefined as string | undefined,
	}
	await fs.mkdir(path.dirname(options.output), { recursive: true })
	await fs.mkdir(options.output)
	const persist = () =>
		fs.writeFile(path.join(options.output, "run.json"), JSON.stringify(run, null, 2) + "\n", { mode: 0o600 })
	const cancellation = new AbortController()
	const abort = () => cancellation.abort()
	process.once("SIGINT", abort)
	process.once("SIGTERM", abort)
	await persist()
	try {
		for (let sample = 0; sample < options.samples; sample++) {
			if (cancellation.signal.aborted) throw new Error("Capture cancelled")
			const result = await runExtensionTests({
				providerMode: options.provider,
				vscodeVersion: "1.141.0",
				extensionDevelopmentPath: extensionPath,
				profileDir: options.profileDir,
				workspace: path.join(options.output, "workspaces", String(sample)),
				artifactsDir: path.join(options.output, "artifacts", String(sample)),
				initializeProfile: true,
				modelId: options.modelId,
				reasoningEffort: options.effort,
				testFile: "live-quality.test",
				requireAllTests: true,
				runId: `quality-${randomUUID()}`,
				signal: cancellation.signal,
				extensionTestsEnv: {
					ALPHA_E2E_QUALITY_CAPTURE: "1",
					...(options.savedProvider ? { ALPHA_E2E_SAVED_PROVIDER: options.savedProvider } : {}),
				},
			})
			if (
				result.status !== "passed" ||
				result.execution !== "extension-host" ||
				!result.hostExitObserved ||
				result.actualVSCodeVersion !== "1.141.0" ||
				result.ownershipGate !== "verified" ||
				result.testCounts?.passed !== LIVE_QUALITY_CASES.length ||
				result.testCounts.pending !== 0 ||
				(options.provider === "live-copilot" && result.providerIdentity?.status !== "unchanged")
			)
				throw new Error(`Real extension quality sample ${sample} failed or lacks complete host evidence`)
			for (const fixture of LIVE_QUALITY_CASES) {
				const raw = JSON.parse(
					(await readBounded(path.join(result.artifactsDir, `${fixture.id}.json`), 4 * 1024 * 1024)).toString(
						"utf8",
					),
				)
				const quality = JSON.parse(
					(
						await readBounded(path.join(result.artifactsDir, `${fixture.id}.quality.json`), 64 * 1024)
					).toString("utf8"),
				)
				if (
					raw.passed !== true ||
					raw.completed !== 1 ||
					quality.correctnessPassed !== true ||
					raw.hostVersion !== "1.141.0" ||
					raw.provider !== run.declared.provider ||
					raw.model?.id !== options.modelId ||
					raw.effort !== options.effort ||
					!Number.isSafeInteger(raw.requests) ||
					raw.requests < 1 ||
					!Number.isSafeInteger(raw.elapsedMs) ||
					raw.elapsedMs < 1
				)
					throw new Error(
						`Quality fixture ${fixture.id} lacks matching correctness, route or measurement evidence`,
					)
				if ((await fs.realpath(raw.extensionPath)) !== (await fs.realpath(extensionPath)))
					throw new Error("Quality fixture loaded a different extension build")
				run.observations.push({
					fixtureId: fixture.id,
					sampleIndex: sample,
					correctness: "passed",
					outcome: "completed",
					configurationDigest: raw.configurationDigest,
					requestMetric: raw.requestMetric,
					providerImplementation: result.providerIdentity?.before ?? null,
					modelCalls: raw.requests,
					durationMs: raw.elapsedMs,
					...qualityWorkCounters(raw.calls as QualityCall[]),
				})
			}
			await persist()
		}
		const after = await verifyBuild()
		if (
			JSON.stringify(before) !== JSON.stringify(after) ||
			harnessDigest !== (await fingerprintArtifactPaths(root, ["apps/vscode-e2e/out"]))
		)
			throw new Error("Loaded build, source or harness changed during quality capture")
		run.status = "passed"
	} catch (error) {
		run.status = "blocked"
		run.failure = error instanceof Error ? error.message : "Quality capture failed"
		throw error
	} finally {
		process.removeListener("SIGINT", abort)
		process.removeListener("SIGTERM", abort)
		await persist()
	}
}

if (require.main === module)
	captureQuality(readQualityCaptureOptions(process.argv.slice(2))).catch(() => {
		console.error(
			"Quality capture failed; inspect the retained run.json and host artifacts. No live pass is inferred.",
		)
		process.exitCode = 1
	})
