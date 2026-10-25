import { strict as assert } from "node:assert"
import { test } from "node:test"
import * as path from "node:path"
import * as os from "node:os"
import * as fs from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { main } from "../../runCampaign"
import type { CampaignEvaluationIdentity } from "../types"

test("suite CLI rejects ambiguous or unsafe selection before creating a campaign or launching a host", async () => {
	const root = path.join(os.tmpdir(), "not-created-development-cli")
	for (const args of [
		["--suite", "smoke"],
		["--suite", "smoke", "--provider", "other"],
		["--suite", "smoke", "--provider", "live-copilot"],
		["--suite", "smoke", "--provider", "scripted", "--model-id", "gpt-5.6-luna"],
		["--suite", "unknown", "--provider", "scripted"],
		["--suite", "smoke", "--provider", "scripted", "--vscode-version", "stable"],
		["--suite", "smoke", "--provider", "scripted", "--vscode-executable", path.join(root, "Code.exe")],
		[
			"--suite",
			"smoke",
			"--provider",
			"scripted",
			"--vscode-version",
			"1.138.0",
			"--vscode-executable",
			"relative.exe",
		],
		["--suite", "smoke", "--provider", "scripted", "--enable-reviewed-patches"],
		["--suite", "smoke", "--config", "unused.json"],
		["--suite", "smoke", "--storage-recovery-root", root],
		["--suite", "smoke", "--shared-storage-root", root],
		["--provider", "scripted", "--config", "unused.json"],
		["--provider", "scripted"],
		["--gate", "--suite", "smoke", "--provider", "live-copilot"],
		["--gate", "--suite", "development", "--provider", "scripted"],
		["--gate", "--config", "unused.json"],
		["--diagnose-failures", "--config", "unused.json"],
		["--gate", "--suite", "core", "--provider", "live-copilot", "--diagnose-failures"],
		["--max-requests", "100", "--config", "unused.json"],
		["--suite", "smoke", "--provider", "scripted", "--max-requests", "1e3"],
		["--suite", "smoke", "--provider", "scripted", "--samples", "0"],
		["--suite", "smoke", "--provider", "scripted", "--samples", "1.5"],
		["--suite", "smoke", "--provider", "scripted", "--samples", "2", "--samples", "3"],
	])
		await assert.rejects(
			main(["--root", root, ...args]),
			(error: unknown) => error instanceof Error,
			JSON.stringify(args),
		)
})

test("soak dry-run declares sample-only collection or explicit post-sample diagnostics", async (context) => {
	const output: string[] = []
	const write = process.stdout.write.bind(process.stdout)
	context.mock.method(process.stdout, "write", (...args: Parameters<typeof process.stdout.write>) => {
		// Node's child test protocol also uses stdout; only the CLI's text belongs to this capture.
		if (typeof args[0] !== "string") return write(...args)
		output.push(args[0])
		return true
	})
	for (const diagnostics of [false, true]) {
		const root = path.join(os.tmpdir(), `alpha-soak-preview-${randomUUID()}`)
		assert.equal(
			await main([
				"--suite",
				"soak",
				"--provider",
				"scripted",
				"--root",
				root,
				"--dry-run",
				...(diagnostics ? ["--diagnose-failures"] : []),
			]),
			0,
		)
		const planned = JSON.parse(output.at(-1)!)
		assert.equal(planned.config.collectionMode, diagnostics ? "sample-then-diagnose" : "sample-only")
		assert.equal(planned.config.samples, 3)
		await assert.rejects(fs.stat(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT")
	}
})

test("core gate dry-run accepts an explicit budget and repeat count without live requests", async () => {
	const root = path.join(os.tmpdir(), `alpha-core-preview-${randomUUID()}`)
	assert.equal(
		await main([
			"--suite",
			"core",
			"--gate",
			"--provider",
			"live-copilot",
			"--model-id",
			"gpt-5.6-luna",
			"--effort",
			"high",
			"--samples",
			"3",
			"--max-requests",
			"100",
			"--root",
			root,
			"--dry-run",
		]),
		0,
	)
	await assert.rejects(fs.stat(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT")
})

test("dry-run plans a live suite without creating directories or trying to execute the selected binary", async () => {
	const root = path.join(os.tmpdir(), `alpha-development-preview-${randomUUID()}`)
	assert.equal(
		await main([
			"--suite",
			"smoke",
			"--provider",
			"live-copilot",
			"--model-id",
			"gpt-5.6-luna",
			"--effort",
			"high",
			"--root",
			root,
			"--profile-dir",
			path.join(root, "not-initialized-profile"),
			"--init-root",
			"--dry-run",
			"--vscode-version",
			"1.138.0",
			"--vscode-executable",
			path.join(root, "does-not-exist", "Code.exe"),
		]),
		0,
	)
	await assert.rejects(fs.stat(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT")
})

test("dry-run rejects structurally unsafe roots just like execution", async () => {
	for (const root of ["relative-root", os.homedir(), path.parse(os.tmpdir()).root]) {
		await assert.rejects(main(["--suite", "smoke", "--provider", "scripted", "--root", root, "--dry-run"]))
	}
})

test("a non-gated live campaign prepares its sidecar before capturing evaluation provenance", async (context) => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-live-provenance-")))
	const require = createRequire(__filename)
	const sidecar = require("../../liveHostProtocol") as typeof import("../../liveHostProtocol")
	const identity = require("../evaluationIdentity") as typeof import("../evaluationIdentity")
	const adapter = require("../extensionAdapter") as typeof import("../extensionAdapter")
	let prepared = false
	const capturedDigests: string[] = []
	context.mock.method(sidecar, "prepareLiveSidecar", async () => {
		prepared = true
		return path.join(root, "sidecar")
	})
	context.mock.method(
		identity,
		"captureCampaignEvaluationIdentity",
		async (): Promise<CampaignEvaluationIdentity> => {
			const harnessDigest = prepared ? "prepared-sidecar" : "unprepared-sidecar"
			capturedDigests.push(harnessDigest)
			return {
				extensionCommit: "commit",
				workingTreeDigest: "source",
				extensionBuildDigest: "build",
				harnessDigest,
				configDigest: "config",
				taskSetDigest: "tasks",
				sourceComponentsDigest: "components",
				unchanged: false,
				missing: [],
			}
		},
	)
	context.mock.method(
		adapter,
		"createExtensionCampaignOperations",
		(options: Parameters<typeof adapter.createExtensionCampaignOperations>[0]) => ({
			runScenario: async () => {
				// The real runExtensionTests boundary also prepares the sidecar on its first launch.
				await sidecar.prepareLiveSidecar()
				return {
					status: "blocked" as const,
					failure: { class: "infrastructure" as const, fingerprint: "fixture-stop" },
					usage: { requests: 0, inputTokens: null, outputTokens: null, cost: null },
				}
			},
			preserveEvidence: async () => "fixture/manifest.json",
			persistReport: options.persistReport,
		}),
	)
	try {
		assert.equal(
			await main([
				"--suite",
				"smoke",
				"--provider",
				"live-copilot",
				"--model-id",
				"fixture-model",
				"--effort",
				"high",
				"--id",
				"live-provenance",
				"--root",
				root,
				"--init-root",
			]),
			2,
		)
		assert.deepEqual(capturedDigests, ["prepared-sidecar", "prepared-sidecar"])
		const directory = path.join(root, "live-provenance")
		const reportFile = (await fs.readdir(directory))
			.filter((file) => /^report-\d+\.json$/.test(file))
			.sort()
			.at(-1)!
		const report = JSON.parse(await fs.readFile(path.join(directory, reportFile), "utf8"))
		assert.equal(report.evaluationIdentity.unchanged, true)
	} finally {
		assert.match(path.basename(root), /^alpha-live-provenance-/)
		await fs.rm(root, { recursive: true, force: true })
	}
})
