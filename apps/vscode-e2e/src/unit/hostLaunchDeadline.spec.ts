import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { prepareEvidenceRun } from "../evidence/paths"
import { HostLaunchFailureError, launchExtensionHost } from "../hostLaunch"

test("an automatic host stuck after its started receipt is terminated with its child before failure returns", async (context) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "alpha-live-deadline-")))
	const expected = { runId: "after-start-deadline", nonce: randomUUID(), actualVSCodeVersion: "1.138.0" }
	const { artifactDirectory } = await prepareEvidenceRun({ artifactsRoot: root, runId: expected.runId })
	const pidsFile = join(artifactDirectory, "owned-fixture-pids.json")
	context.after(async () => {
		try {
			const pids = JSON.parse(await readFile(pidsFile, "utf8")) as { root: number; child: number }
			for (const pid of [pids.root, pids.child]) {
				try {
					process.kill(pid)
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
				}
			}
		} finally {
			await rm(root, { recursive: true, force: true })
		}
	})
	const startedFile = join(artifactDirectory, "live-host-started.json")
	// This directly spawned Node fixture writes the protocol inputs; it does not claim real host evidence.
	const script = [
		"const fs = require('node:fs')",
		"const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
		"fs.writeFileSync(process.argv[1], JSON.stringify({ root: process.pid, child: child.pid }))",
		`fs.writeFileSync(process.argv[2], JSON.stringify({ ...${JSON.stringify(expected)}, schemaVersion: 1, launchKind: 'development-sidecar', pid: process.pid, ppid: process.ppid, status: 'started' }))`,
		"setInterval(() => {}, 1000)",
	].join(";\n")
	await assert.rejects(
		launchExtensionHost({
			launchKind: "development-sidecar",
			vscodeExecutablePath: process.execPath,
			extensionDevelopmentPath: root,
			launchArgs: ["-e", script, "--", pidsFile, startedFile],
			liveHost: { artifactsDir: artifactDirectory, expected, executionTimeoutMs: 1 },
		}),
		(error: unknown) => {
			assert.ok(error instanceof HostLaunchFailureError)
			assert.equal(error.code, "host-execution-timeout")
			assert.equal(error.hostExitObserved, true)
			assert.equal(error.cleanupVerified, true)
			return true
		},
	)
	const pids = JSON.parse(await readFile(pidsFile, "utf8")) as { root: number; child: number }
	for (const pid of [pids.root, pids.child]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
})
