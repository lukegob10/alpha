import { glob, mkdir, readFile, readdir, unlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { require as tsRequire } from "tsx/cjs/api"
import { normalizeVitestEvidence, readExecutionJson, testEvidenceVerdict } from "./execution-evidence.mjs"
import { hostSuiteVerdict, outcomeCampaignVerdict, readHostReceipts } from "./host-evidence.mjs"
import { collectOutcomeBuild, OutcomeProofError, readOutcomeProofs } from "./outcome-proof.mjs"

const { rejectSymlinkComponents } = tsRequire("../../apps/vscode-e2e/src/evidence/paths.ts", import.meta.url)

export async function expectedTestFiles(root, descriptor, args) {
	let patterns
	let exclude = []
	if (descriptor.runner === "vitest" && descriptor.config) {
		const config = tsRequire(`../../packages/evals/vitest.${descriptor.config}.config.ts`, import.meta.url).default
		if (!Array.isArray(config?.test?.include) || !config.test.include.every((value) => typeof value === "string"))
			throw new Error("Unsupported evaluator include configuration")
		patterns = config.test.include.map((pattern) => `packages/evals/${pattern}`)
		const defaults = tsRequire("vitest/config", import.meta.url).configDefaults
		exclude = (config.test.exclude ?? defaults.exclude).map((pattern) => `packages/evals/${pattern}`)
	} else if (descriptor.runner === "vitest" && (descriptor.packageDir || args.includes("src"))) {
		const directory = descriptor.packageDir ?? "src"
		// The catalog owns configuration; a test inventory root may be a fixture
		// without a config and must still honor the owning package's exclusions.
		const configPath = fileURLToPath(new URL(`../../${directory}/vitest.config.ts`, import.meta.url))
		const configured = await readFile(configPath)
			.then(() => true)
			.catch((error) => {
				if (error.code === "ENOENT") return false
				throw error
			})
		const config = configured ? tsRequire(configPath, import.meta.url).default : { test: {} }
		const defaults = tsRequire("vitest/config", import.meta.url).configDefaults
		patterns = (config.test.include ?? defaults.include).map((pattern) => `${directory}/${pattern}`)
		exclude = (config.test.exclude ?? defaults.exclude).map((pattern) => `${directory}/${pattern}`)
	} else if (descriptor.runner === "node") {
		patterns = args.includes("test:tooling")
			? JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
					.scripts["test:tooling"].split(/\s+/)
					.filter((argument) => argument.startsWith("scripts/") && argument.includes(".test."))
			: ["apps/vscode-e2e/src/**/*.spec.ts"]
	}
	if (!patterns) return null
	const matches = []
	for await (const file of glob(patterns, { cwd: root, exclude })) {
		const normalized = file.replaceAll("\\", "/")
		const filters =
			descriptor.runner === "vitest" && !descriptor.config
				? args.slice(args.indexOf("test") + 1).filter((value) => !value.startsWith("-"))
				: []
		if (
			!filters.length ||
			filters.some((filter) =>
				normalized.slice((descriptor.packageDir ?? "src").length + 1).includes(filter.replaceAll("\\", "/")),
			)
		)
			matches.push(normalized)
		if (matches.length > 10_000) throw new Error("Test inventory exceeds its bound")
	}
	return matches.sort()
}

export async function laneExpectedInventories(root, lane, name) {
	const inventories = []
	for (const [index, args] of lane.commands.entries()) {
		const descriptor = lane.receipts?.[index] ?? (name === "focused" ? { runner: "vitest" } : null)
		inventories.push(
			descriptor && ["node", "vitest"].includes(descriptor.runner)
				? await expectedTestFiles(root, descriptor, args)
				: null,
		)
	}
	return inventories
}

export async function configureLaneEvidence({ lane, name, root, directory, id }) {
	const campaignRoot =
		name === "outcomes"
			? path.join(process.env.RUNNER_TEMP || os.tmpdir(), "alpha-harness-outcomes", id.slice(-8))
			: null
	const descriptors = lane.commands.map(
		(_command, index) => lane.receipts?.[index] ?? (name === "focused" ? { runner: "vitest" } : null),
	)
	const commands = lane.commands.map((args, index) => {
		const descriptor = descriptors[index]
		if (descriptor?.runner === "vitest")
			return [
				...args,
				"--reporter=dot",
				"--reporter=json",
				`--outputFile=${path.join(directory, `step-${index}.raw.json`)}`,
			]
		if (descriptor?.runner === "task-outcomes") return [...args, "--root", campaignRoot, "--init-root", "--id", id]
		return args
	})
	const hostDirectories = new Map()
	for (const [index, descriptor] of descriptors.entries()) {
		if (["extension-host", "task-outcomes"].includes(descriptor?.runner)) {
			const destination = path.join(directory, `step-${index}-hosts`)
			await mkdir(destination, { mode: 0o700 })
			hostDirectories.set(index, destination)
		}
	}
	return {
		commands,
		campaignRoot,
		environment: (index) => ({
			ALPHA_HARNESS_REPOSITORY_ROOT: root,
			ALPHA_HARNESS_EVIDENCE_FILE:
				descriptors[index]?.runner === "node"
					? path.join(directory, `step-${index}.execution.json`)
					: undefined,
			ALPHA_HARNESS_EVIDENCE_DIR: hostDirectories.get(index),
		}),
		verify: async ({ index, args, step }) => {
			const descriptor = descriptors[index]
			if (!descriptor)
				return {
					status: "passed",
					kind: name === "static" ? "mechanical-command" : "command-only",
					execution: "unavailable",
				}
			let stage = "test-execution"
			try {
				if (["node", "vitest"].includes(descriptor.runner)) {
					const rawFile = path.join(directory, `step-${index}.raw.json`)
					const receipt =
						descriptor.runner === "node"
							? await readExecutionJson(path.join(directory, `step-${index}.execution.json`))
							: await readExecutionJson(rawFile)
									.then((value) => normalizeVitestEvidence(value, root))
									.finally(() => unlink(rawFile).catch(() => {}))
					const verdict = testEvidenceVerdict(receipt, descriptor.requireAllTests)
					if (verdict.status !== "passed") return verdict
					const expected = await expectedTestFiles(root, descriptor, args)
					const observed = verdict.receipt.files.map((file) => file.path).sort()
					if (expected && (expected.length === 0 || JSON.stringify(expected) !== JSON.stringify(observed)))
						return { status: "failed", reason: "incomplete_test_inventory", receipt: verdict.receipt }
					return verdict
				}
				stage = "host-receipts"
				const receipts = await readHostReceipts(hostDirectories.get(index), step.startedAt)
				if (descriptor.runner === "extension-host") return hostSuiteVerdict(receipts, descriptor.suite)
				stage = "campaign-report"
				const campaignDirectory = path.join(campaignRoot, id)
				const reports = (await readdir(campaignDirectory))
					.filter((file) => /^report-\d{5}\.json$/.test(file))
					.sort()
				const report = await readExecutionJson(path.join(campaignDirectory, reports.at(-1)))
				const verdict = outcomeCampaignVerdict(report, receipts, id)
				if (verdict.status !== "passed") return verdict
				stage = "outcome-build"
				const build = await collectOutcomeBuild(root)
				stage = "outcome-capture"
				const proofs = await readOutcomeProofs(campaignDirectory, verdict.campaign, receipts, build)
				return { ...verdict, proofs, build }
			} catch (error) {
				return {
					status: "failed",
					stage,
					reason: error instanceof OutcomeProofError ? error.reason : "missing_or_invalid_execution_receipt",
				}
			}
		},
	}
}
