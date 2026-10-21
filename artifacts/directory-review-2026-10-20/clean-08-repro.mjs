import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { CustomToolRegistry } from "../../packages/core/src/custom-tools/custom-tool-registry.ts"
import { ManagedSubagentWorktreeService } from "../../packages/core/src/worktree/managed-subagent-worktree.ts"
import { worktreeIncludeService } from "../../packages/core/src/worktree/worktree-include.ts"
import { BoundedDelegationManager } from "../../src/core/agent/BoundedDelegationManager.ts"

// Read-only production audit: all mutations below are confined to one owned temporary directory.
const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-clean-08-"))
try {
	const workspaceA = path.join(root, "workspace-a")
	const workspaceB = path.join(root, "workspace-b")
	await fs.mkdir(workspaceA)
	await fs.mkdir(workspaceB)
	await fs.writeFile(path.join(workspaceA, "package.json"), JSON.stringify({ type: "module" }))
	const source = path.join(workspaceA, "audit-tool.js")
	await fs.writeFile(source, 'export default { name: "audit_tool", description: "version one", execute: async () => "from workspace A" }')
	const directoryTimestamp = new Date("2026-01-01T00:00:00.000Z")
	await fs.utimes(workspaceA, directoryTimestamp, directoryTimestamp)
	const registry = new CustomToolRegistry({ cacheDir: path.join(root, "cache") })
	await registry.loadFromDirectoriesIfStale([workspaceA])
	assert.equal(registry.get("audit_tool").description, "version one")
	await registry.loadFromDirectoriesIfStale([workspaceB])
	assert.equal(await registry.get("audit_tool").execute({}, {}), "from workspace A")
	console.log("CONFIRMED: a fresh workspace B catalog still contains and executes workspace A's local tool")

	await fs.writeFile(source, 'export default { name: "audit_tool", description: "version two", execute: async () => "updated" }')
	// Hold directory metadata unchanged to make the file-content-only change deterministic on every filesystem.
	await fs.utimes(workspaceA, directoryTimestamp, directoryTimestamp)
	await registry.loadFromDirectoriesIfStale([workspaceA])
	assert.equal(registry.get("audit_tool").description, "version one")
	console.log("CONFIRMED: changing a tool file without a directory-entry change retains its previous definition")
	await registry.loadFromDirectories([workspaceA])
	assert.equal(registry.get("audit_tool").description, "version one")
	console.log("CONFIRMED: explicit refresh of an edited JavaScript tool reuses the previous module URL")
	await fs.unlink(source)
	await registry.loadFromDirectories([workspaceA])
	assert.equal(registry.has("audit_tool"), true)
	console.log("CONFIRMED: explicit refresh after deletion leaves the deleted tool registered")

	const storage = path.join(root, "storage")
	const exec = promisify(execFile)
	const repository = path.join(root, "repository")
	await fs.mkdir(repository)
	for (const args of [["init"], ["config", "user.name", "Audit"], ["config", "user.email", "audit@example.invalid"]]) {
		await exec("git", args, { cwd: repository, windowsHide: true })
	}
	await fs.writeFile(path.join(repository, "value.txt"), "baseline")
	await exec("git", ["add", "."], { cwd: repository, windowsHide: true })
	await exec("git", ["commit", "-m", "audit fixture"], { cwd: repository, windowsHide: true })
	const service = new ManagedSubagentWorktreeService()
	const validated = await service.validateScope(repository, ["value.txt"])
	let releaseCopy
	let copyStarted
	const copyBarrier = new Promise((resolve) => { releaseCopy = resolve })
	const copyEntered = new Promise((resolve) => { copyStarted = resolve })
	const originalCopy = worktreeIncludeService.copyWorktreeIncludeFiles
	let prepared
	let completion
	let runSettled = false
	let signalObserved
	worktreeIncludeService.copyWorktreeIncludeFiles = async () => {
		copyStarted()
		await copyBarrier
		return []
	}
	try {
		const manager = new BoundedDelegationManager(async (envelope, signal) => {
			signalObserved = signal
			// Mirrors AlphaProvider.executeSubagentEnvelope's actual worker startup call.
			prepared = await service.create(storage, envelope.id, validated)
			return { taskId: envelope.id, status: "completed", summary: "fixture", evidence: [], changedFiles: [], verification: [], remainingRisks: [], usage: { durationMs: 0 } }
		}, 1)
		completion = manager.run({ id: "startup-child", parentTaskId: "root", budget: { timeoutMs: 60_000 }, modelRoute: { id: "balanced" } })
		void completion.then(() => { runSettled = true })
		await copyEntered
		assert.equal(manager.cancel("startup-child"), true)
		await Promise.resolve()
		await Promise.resolve()
		assert.equal(signalObserved.aborted, true)
		assert.equal(runSettled, false)
		console.log("CONFIRMED: aborting a managed worker at the native-copy startup boundary does not stop or settle startup")
		releaseCopy()
		assert.equal((await completion).status, "cancelled")

		// Modify only patchFile in a full, legitimately created and captured Git-backed artifact.
		await fs.writeFile(path.join(prepared.workspacePath, "value.txt"), "worker result")
		const captured = await service.capture(storage, prepared.artifact.id, true)
		assert.equal(captured.status, "pending_review")
		const artifactDir = path.join(storage, "subagent-change-sets", captured.id)
		const metadataPath = path.join(artifactDir, "metadata.json")
		const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"))
		const outsideProposal = path.join(root, "outside-proposal-canary.txt")
		await fs.writeFile(outsideProposal, "must survive proposal discard")
		metadata.patchFile = path.relative(artifactDir, outsideProposal)
		await fs.writeFile(metadataPath, JSON.stringify(metadata))
		await service.discard(storage, captured.id)
		await assert.rejects(fs.access(outsideProposal), { code: "ENOENT" })
		console.log("CONFIRMED: tampering only patchFile on a real captured proposal deletes a file outside proposal storage")
	} finally {
		releaseCopy()
		await completion
		worktreeIncludeService.copyWorktreeIncludeFiles = originalCopy
		if (prepared) await service.deleteArtifact(storage, prepared.artifact.id)
	}
} finally {
	await fs.rm(root, { recursive: true, force: true })
}
