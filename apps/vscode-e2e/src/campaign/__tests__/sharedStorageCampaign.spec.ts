import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { runSharedStorageCampaign } from "../sharedStorageCampaign"
import { openCampaignRoot } from "../reportStore"
import { auditRetainedStorage } from "../../evidence/retainedStorageBudget"
import {
	ROLES,
	publish,
	readOptional,
	validateManifest,
	waitUntil,
	type HostIdentity,
} from "../../evidence/sharedStorageProtocol"
import type { CaptureRunEvidenceOptions } from "../../evidence/types"
import type { CampaignHost } from "../types"
import { main } from "../../runCampaign"

type Fault =
	| "none"
	| "missing-host"
	| "stale-nonce"
	| "duplicate-pid"
	| "split-storage"
	| "changed-identity"
	| "ancestry"
	| "host-failure"
	| "request-limit"
	| "shared-control"
	| "cleanup"
	| "capture"
	| "capture-incomplete"
	| "cleanup-timeout"
	| "capture-timeout"
	| "bundle"
	| "root-exit"
	| "launch-rejection"
	| "cancel"
	| "storage-budget"
	| "scan-incomplete"

/** File receipts simulate the external hosts; no process, live provider or real-host evidence is manufactured. */
async function exercise(fault: Fault, version: CampaignHost["version"] = "1.122.1") {
	const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-pair-unit-")))
	const root = path.join(temporary, "campaign")
	const executable = await fs.realpath(process.execPath)
	const extension = path.join(temporary, "extension")
	const entry = path.join(temporary, "entry.js")
	const externalAbort = new AbortController()
	const pids = [process.pid + 1, process.pid + 2]
	let expired = false
	let launched = 0
	let familyClosed = false
	let capture: CaptureRunEvidenceOptions | undefined
	let leasePath: string | undefined
	let actualStorage: string | undefined
	try {
		await fs.mkdir(path.join(extension, "dist"), { recursive: true })
		await fs.writeFile(path.join(extension, "dist", "extension.js"), "original")
		await fs.writeFile(
			path.join(extension, "package.json"),
			JSON.stringify({ publisher: "AlphaInc", name: "alpha" }),
		)
		await fs.writeFile(entry, "exports.run = async () => {}")
		await openCampaignRoot(root, true)
		await fs.mkdir(path.join(root, "prior-run"))
		await fs.writeFile(path.join(root, "prior-run", "retained.bin"), Buffer.alloc(2_048))
		const report = await runSharedStorageCampaign(
			{ fixtureRoot: root, host: { version, executable }, signal: externalAbort.signal },
			{
				extensionPath: extension,
				hostEntry: entry,
				monotonicNow: () => (expired ? 180_001 : 0),
				auditStorage: async (options) => {
					assert.deepEqual(options.roots, [{ path: root, label: "shared-storage" }])
					assert.equal(launched, 0)
					await options.assertOwned(root)
					const result = await auditRetainedStorage({
						...options,
						limits: fault === "storage-budget" ? { maxBytes: 1_024 } : undefined,
					})
					if (fault === "scan-incomplete")
						return {
							status: "unknown",
							complete: false,
							bytes: 0,
							entries: 0,
							roots: 1,
							reason: "unreadable",
						}
					assert.ok(result.bytes >= 2_048)
					return result
				},
				assertAncestry: async (owner, pid) => {
					assert.equal(owner, process.pid)
					assert.ok(pid !== undefined && pids.includes(pid))
					if (fault === "ancestry") throw new Error("private ancestry detail")
				},
				runProcess: async (command, options) => {
					launched++
					assert.ok(options.signal)
					assert.equal(command.executable, executable)
					assert.equal(options.maxOutputBytes, 32_768)
					assert.ok(command.args.includes(`--extensionTestsPath=${entry}`))
					const artifactsRoot = command.env!.ALPHA_PAIR_ARTIFACTS!
					const runId = command.env!.ALPHA_PAIR_RUN_ID!
					const directory = path.join(artifactsRoot, runId)
					const manifest = validateManifest(await readOptional(directory, "pair-manifest.json"))
					assert.equal(manifest.hostVersion, version)
					assert.equal(manifest.controllerPid, process.pid)
					assert.equal(command.args.filter((value) => value.endsWith(".code-workspace")).length, 2)
					for (const role of ROLES) {
						const workspace = JSON.parse(await fs.readFile(manifest.roles[role].workspaceFile, "utf8"))
						assert.deepEqual(workspace.folders, [{ path: manifest.roles[role].workspace }])
					}
					const profileVersion = path.join(manifest.profileRoot, version)
					leasePath = path.join(profileVersion, ".alpha-e2e-launch.json")
					assert.equal(JSON.parse(await fs.readFile(leasePath, "utf8")).pid, process.pid)
					if (fault === "launch-rejection") throw new Error("private launch payload")
					const result = {
						exitCode: 0,
						signal: null,
						stdout: "",
						stderr: "",
						outputTruncated: false,
						cleanupVerified: fault !== "cleanup" && fault !== "root-exit",
					}
					if (fault === "root-exit") {
						familyClosed = true
						return result
					}
					actualStorage = path.join(profileVersion, "user-data", "User", "globalStorage", "alphainc.alpha")
					await fs.mkdir(actualStorage, { recursive: true })
					const identities = ROLES.map(
						(role, index): HostIdentity => ({
							runId,
							nonce: manifest.nonce,
							role,
							pid: pids[index]!,
							hostVersion: version,
							workspaceFile: manifest.roles[role].workspaceFile,
							storagePath: actualStorage!,
							persistenceFile: path.join(actualStorage!, "agent_control.json"),
						}),
					)
					if (fault === "stale-nonce") identities[1]!.nonce = "stale"
					if (fault === "duplicate-pid") identities[1]!.pid = pids[0]!
					if (fault === "split-storage") {
						identities[1]!.storagePath = path.join(profileVersion, "separate-storage")
						identities[1]!.persistenceFile = path.join(identities[1]!.storagePath, "agent_control.json")
					}
					const stopped = options.signal.aborted
						? Promise.resolve()
						: new Promise<void>((resolve) =>
								options.signal!.addEventListener("abort", () => resolve(), { once: true }),
							)
					const waitPhase = (name: string) =>
						waitUntil(
							async () => {
								if (options.signal!.aborted) throw new Error("aborted")
								return (await readOptional(directory, `${name}.json`)) !== undefined
							},
							Date.now() + 5_000,
							"unit_barrier_timeout",
						)
					try {
						await publish(directory, "ready-a.json", identities[0])
						if (fault === "missing-host") {
							expired = true
							await stopped
							return result
						}
						await publish(directory, "ready-b.json", identities[1])
						if (fault === "cancel") {
							externalAbort.abort()
							await stopped
							return result
						}
						if (fault === "host-failure") {
							await publish(directory, "failed-b.json", {
								runId,
								nonce: manifest.nonce,
								role: "b",
								stage: "configuration",
								code: "operation_failed",
							})
							await stopped
							return result
						}
						await waitPhase("start")
						for (const identity of identities) {
							await publish(
								directory,
								`entered-${identity.role}.json`,
								fault === "changed-identity" ? { ...identity, pid: identity.pid + 10 } : identity,
							)
							await publish(directory, `task-${identity.role}.json`, {
								...identity,
								taskId: `task-${identity.role}`,
							})
						}
						await waitPhase("respond")
						assert.ok(await readOptional(directory, "overlap.json"))
						await fs.writeFile(
							identities[0]!.persistenceFile,
							JSON.stringify({
								agents: ROLES.map((role) => ({
									taskId: `task-${role}`,
									status: fault === "shared-control" && role === "b" ? "running" : "completed",
								})),
							}),
						)
						if (fault === "bundle")
							await fs.writeFile(path.join(extension, "dist", "extension.js"), "changed")
						for (const identity of identities)
							await publish(directory, `done-${identity.role}.json`, {
								...identity,
								taskId: `task-${identity.role}`,
								requests: fault === "request-limit" ? 2 : 1,
								terminalCount: 1,
							})
						await stopped
					} catch (error) {
						if (!options.signal.aborted) throw error
					} finally {
						familyClosed = true
						if (fault === "cleanup-timeout") expired = true
					}
					return result
				},
				capture: async (options) => {
					assert.equal(familyClosed, true)
					assert.ok(leasePath)
					await fs.access(leasePath)
					capture = options
					if (fault === "capture-timeout") expired = true
					if (fault === "capture") throw new Error("private provider data")
					if (options.storagePath) {
						assert.equal(options.storagePath, actualStorage)
						await options.assertSourceOwned!(options.storagePath)
					}
					return {
						artifactDirectory: path.join(options.artifactsRoot, options.runId),
						manifestPath: "unit-manifest",
						summary: { category: "none", code: "NONE" },
						captureComplete: fault !== "capture-incomplete",
					}
				},
			},
		)
		const leaseRetained = leasePath
			? await fs.access(leasePath).then(
					() => true,
					() => false,
				)
			: false
		assert.deepEqual(JSON.parse(await fs.readFile(report.reportPath, "utf8")), report)
		assert.doesNotMatch(JSON.stringify(report), /private|payload|provider data/)
		if (report.artifactDirectory)
			await assert.rejects(fs.access(path.join(report.artifactDirectory, ".retention-eligible.json")), {
				code: "ENOENT",
			})
		return { report, launched, capture, leaseRetained }
	} finally {
		assert.ok(path.basename(temporary).startsWith("alpha-pair-unit-"))
		assert.equal(path.dirname(temporary), await fs.realpath(os.tmpdir()))
		await fs.rm(temporary, { recursive: true })
	}
}

for (const version of ["1.122.1", "1.136.1"] as const)
	test(`controller succeeds only after both durable receipts and cleanup (${version})`, async () => {
		const { report, capture, leaseRetained } = await exercise("none", version)
		assert.equal(report.status, "passed")
		assert.equal(report.requests, 2)
		assert.equal(report.readyHostCount, 2)
		assert.equal(report.doneHostCount, 2)
		assert.equal(report.identitiesVerified, true)
		assert.equal(report.cleanupVerified, true)
		assert.equal(report.leaseReleased, true)
		assert.equal(leaseRetained, false)
		assert.equal(report.retention, "held")
		assert.deepEqual(capture?.metadata.taskIds, ["task-a", "task-b"])
		assert.equal(capture?.metadata.hostVersion, version)
	})
for (const fault of [
	"stale-nonce",
	"duplicate-pid",
	"split-storage",
	"changed-identity",
	"ancestry",
	"host-failure",
	"request-limit",
] as const)
	test(`rejects ${fault} independently with unknown total requests`, async () => {
		const { report, leaseRetained, capture } = await exercise(fault)
		assert.equal(report.status, "failed")
		assert.equal(
			report.failure?.code,
			fault === "host-failure" ? "host_failed" : fault === "ancestry" ? "operation_failed" : "assertion_failed",
		)
		if (fault === "changed-identity") assert.equal(report.failure?.stage, "entered")
		if (fault === "request-limit") assert.equal(report.failure?.stage, "done")
		if (fault === "ancestry") {
			assert.equal(report.identitiesVerified, false)
			assert.equal(capture?.storagePath, undefined)
			assert.equal(capture?.metadata.hostVersion, null)
		}
		assert.equal(report.requests, null)
		assert.equal(report.cleanupVerified, true)
		assert.equal(leaseRetained, false)
		assert.equal(report.bundleHashAfter, report.bundleHashBefore)
		if (fault === "request-limit") assert.equal(report.readyHostCount, 2)
	})
test("missing second host expires on the monotonic budget and preserves first ready receipt", async () => {
	const { report } = await exercise("missing-host")
	assert.equal(report.status, "timed_out")
	assert.equal(report.readyHostCount, 1)
	assert.equal(report.requests, null)
})
test("external cancellation propagates to the owned family", async () => {
	const { report } = await exercise("cancel")
	assert.equal(report.status, "cancelled")
	assert.equal(report.cleanupVerified, true)
})
for (const fault of ["cleanup-timeout", "capture-timeout"] as const)
	test(`budget expires during ${fault} without a false pass or skipped cleanup`, async () => {
		const { report, leaseRetained } = await exercise(fault)
		assert.equal(report.status, "timed_out")
		assert.equal(report.failure?.code, "controller_timeout")
		assert.equal(report.requests, 2)
		assert.equal(report.cleanupVerified, true)
		assert.equal(report.leaseReleased, true)
		assert.equal(leaseRetained, false)
	})
for (const fault of ["cleanup", "root-exit", "launch-rejection"] as const)
	test(`${fault} retains the lease and forbids storage capture`, async () => {
		const { report, capture, leaseRetained } = await exercise(fault)
		assert.equal(report.status, "blocked")
		assert.equal(report.stopReason, "cleanup_unverified")
		assert.equal(report.cleanupVerified, false)
		assert.equal(report.leaseReleased, false)
		assert.equal(leaseRetained, true)
		assert.equal(capture, undefined)
	})
for (const fault of ["shared-control", "capture", "capture-incomplete", "bundle"] as const)
	test(`${fault} cannot erase a failure or validated request usage`, async () => {
		const { report } = await exercise(fault)
		assert.equal(report.status, "failed")
		assert.equal(report.requests, 2)
		assert.equal(report.leaseReleased, true)
		assert.equal(
			report.failure?.stage,
			fault === "shared-control" ? "shared_control" : fault === "bundle" ? "bundle" : "capture",
		)
		if (fault === "capture-incomplete") assert.equal(report.failure?.code, "capture_incomplete")
	})
for (const fault of ["storage-budget", "scan-incomplete"] as const)
	test(`${fault} includes prior runs and blocks launch`, async () => {
		const { report, launched, capture } = await exercise(fault)
		assert.equal(report.status, "blocked")
		assert.equal(launched, 0)
		assert.equal(capture, undefined)
		assert.equal(report.requests, null)
		assert.equal(report.stopReason, fault === "storage-budget" ? "storage_budget" : "scan_incomplete")
	})

test("specialized CLI modes reject mixed settings and unsupported hosts before launch", async () => {
	for (const extra of [
		["--storage-recovery-root", "unused"],
		["--root", "unused"],
		["--config", "unused"],
		["--profile-dir", "unused"],
		["--init-root"],
		["--enable-reviewed-patches"],
	])
		await assert.rejects(main(["--shared-storage-root", "unused", ...extra]), /Conflicting campaign modes/)
	await assert.rejects(
		main(["--shared-storage-root", "unused", "--vscode-version", "stable"]),
		/Unsupported shared-storage host/,
	)
	await assert.rejects(main(["--shared-storage-root", "unused"]), /explicit_host_required/)
	await assert.rejects(
		main(["--shared-storage-root", "unused", "--shared-storage-root", "unused"]),
		/Invalid campaign option/,
	)
})
