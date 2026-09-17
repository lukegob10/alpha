import { execFile } from "child_process"
import { promisify } from "util"
import * as fs from "fs/promises"
import * as path from "path"
import { randomUUID } from "crypto"
import { TestRunError } from "./runFailure"

const executeFile = promisify(execFile)

async function readProcessParents(): Promise<Map<number, number>> {
	const parents = new Map<number, number>()
	if (process.platform === "win32") {
		// Only numeric process relationships are collected; no command lines or credentials.
		const { stdout } = await executeFile(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress",
			],
			{ timeout: 10_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
		)
		const rows: unknown = JSON.parse(stdout)
		if (!Array.isArray(rows)) throw new Error("Process ancestry is unavailable")
		for (const row of rows) {
			if (
				typeof row === "object" &&
				row &&
				Number.isSafeInteger(row.ProcessId) &&
				Number.isSafeInteger(row.ParentProcessId)
			) {
				parents.set(row.ProcessId, row.ParentProcessId)
			}
		}
	} else if (process.platform === "linux" || process.platform === "darwin") {
		const { stdout } = await executeFile("ps", ["-A", "-o", "pid=,ppid="], {
			timeout: 10_000,
			maxBuffer: 2 * 1024 * 1024,
		})
		for (const line of stdout.split("\n")) {
			const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
			if (match) parents.set(Number(match[1]), Number(match[2]))
		}
	} else {
		throw new Error("Process ancestry verification is unsupported on this platform")
	}
	return parents
}

export async function assertRunnerAncestry(
	runnerPid: number,
	currentPid = process.pid,
	getParents: () => Promise<Map<number, number>> = readProcessParents,
): Promise<void> {
	if (!Number.isSafeInteger(runnerPid) || runnerPid <= 0 || runnerPid === currentPid) {
		throw new Error("Invalid test runner owner")
	}
	const parents = await getParents()
	const visited = new Set<number>()
	let cursor: number | undefined = currentPid
	while (cursor !== undefined && cursor > 0 && !visited.has(cursor)) {
		if (cursor === runnerPid) return
		visited.add(cursor)
		cursor = parents.get(cursor)
	}
	throw new Error(
		"The test host is not owned by this runner; close the dedicated profile's existing windows before retrying",
	)
}

/** Cooperating launchers serialize per profile/version; unknown or crashed leases are never stolen by age. */
export async function acquireProfileLease(userDataDir: string): Promise<() => Promise<void>> {
	const leasePath = path.join(path.dirname(userDataDir), ".alpha-e2e-launch.json")
	const token = randomUUID()
	const candidatePath = `${leasePath}.${token}.candidate`
	const serialized = JSON.stringify({ schemaVersion: 1, token, pid: process.pid })
	await fs.writeFile(candidatePath, serialized, { flag: "wx", mode: 0o600 })
	try {
		// Atomic no-replace publication avoids leaving an empty canonical lease if writing is interrupted.
		await fs.link(candidatePath, leasePath)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			throw new TestRunError(
				"profile-busy",
				"This dedicated profile already has a runner lease; close its hosts and inspect the lease offline",
			)
		}
		throw error
	} finally {
		await fs.unlink(candidatePath)
	}
	return async () => {
		if ((await fs.readFile(leasePath, "utf8")) !== serialized)
			throw new Error("Test profile launch ownership was lost")
		await fs.unlink(leasePath)
	}
}
