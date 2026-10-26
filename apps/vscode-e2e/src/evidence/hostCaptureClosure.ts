import { execFile } from "node:child_process"
import * as path from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)

export interface CaptureProcessSnapshot {
	pid: number
	ppid: number
	commandLine: string | null
	processGroupId?: number
}

export interface HostCaptureClosure {
	schemaVersion: 1
	scope: "observed-owned-host-process-family"
	observedAt: string
	cleanupVerified: boolean
	source: "prior-owned-tree-cleanup" | "process-snapshot"
	ownedPids: number[]
	matchingProcessIds: number[]
	unavailableCommandLines: number
	failure?: "host-not-closed" | "prior-cleanup-unverified" | "process-proof-unavailable" | "owned-process-remains"
}

type ClosureInput = {
	hostExitObserved: boolean
	previousCleanupVerified?: boolean
	launchedHostPid?: number
	extensionHostPid?: number
	extensionHostParentPid?: number
	userDataDir: string
	platform?: NodeJS.Platform
}

/** CommandLineToArgvW quote/backslash rules; arguments and raw command lines are never retained. */
function windowsArguments(commandLine: string): string[] {
	const args: string[] = []
	let current = ""
	let quoted = false
	let started = false
	for (let index = 0; index < commandLine.length; index++) {
		const character = commandLine[index]!
		if (/\s/.test(character) && !quoted) {
			if (started) args.push(current)
			current = ""
			started = false
			continue
		}
		started = true
		if (character === "\\") {
			let count = 1
			while (commandLine[index + count] === "\\") count++
			if (commandLine[index + count] === '"') {
				current += "\\".repeat(Math.floor(count / 2))
				if (count % 2) current += '"'
				else quoted = !quoted
				index += count
			} else {
				current += "\\".repeat(count)
				index += count - 1
			}
		} else if (character === '"') quoted = !quoted
		else current += character
	}
	if (quoted) throw new Error("Malformed process command line")
	if (started) args.push(current)
	return args
}

function profileMatch(commandLine: string, userDataDir: string, platform: NodeJS.Platform): boolean {
	if (!/--user-data-dir/i.test(commandLine)) return false
	const normalize = (value: string) =>
		platform === "win32"
			? path.win32
					.normalize(value)
					.replace(/[\\/]+$/, "")
					.toLowerCase()
			: path.posix.normalize(value).replace(/\/+$/, "")
	const expected = normalize(userDataDir)
	if (platform === "win32") {
		const args = windowsArguments(commandLine)
		for (let index = 0; index < args.length; index++) {
			const argument = args[index]!
			const value = /^--user-data-dir=/i.test(argument)
				? argument.slice(argument.indexOf("=") + 1)
				: /^--user-data-dir$/i.test(argument)
					? args[++index]
					: undefined
			if (value !== undefined && normalize(value) === expected) return true
		}
		return false
	}
	// ps renders argv without a lossless delimiter. Match an exact bounded profile value conservatively.
	const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	return new RegExp(`(?:^|\\s)["']?--user-data-dir(?:=|\\s+)["']?${escaped}["']?(?=\\s|$)`).test(commandLine)
}

async function readCaptureProcesses(platform: NodeJS.Platform): Promise<CaptureProcessSnapshot[]> {
	if (platform === "win32") {
		const { stdout } = await execute(
			"powershell.exe",
			[
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
			],
			{ timeout: 30_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: "buffer" },
		)
		const rows: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout))
		if (!Array.isArray(rows)) throw new Error("Process snapshot unavailable")
		return rows.map((row: { ProcessId: number; ParentProcessId: number; CommandLine: string | null }) => ({
			pid: row.ProcessId,
			ppid: row.ParentProcessId,
			commandLine: row.CommandLine,
		}))
	}
	if (platform !== "linux" && platform !== "darwin") throw new Error("Process snapshot unsupported")
	const { stdout } = await execute("ps", ["-A", "-o", "pid=,ppid=,pgid=,args="], {
		timeout: 10_000,
		maxBuffer: 4 * 1024 * 1024,
		encoding: "buffer",
	})
	return new TextDecoder("utf-8", { fatal: true })
		.decode(stdout)
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => {
			const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
			if (!match) throw new Error("Malformed process snapshot")
			return {
				pid: Number(match[1]),
				ppid: Number(match[2]),
				processGroupId: Number(match[3]),
				commandLine: match[4]!,
			}
		})
}

/** Observe only this run's known family/profile. Escaped daemons are outside this receipt's explicit scope. */
export async function observeHostCaptureClosure(
	input: ClosureInput,
	readSnapshot: () => Promise<CaptureProcessSnapshot[]> = () =>
		readCaptureProcesses(input.platform ?? process.platform),
): Promise<HostCaptureClosure> {
	const pids = [input.launchedHostPid, input.extensionHostPid, input.extensionHostParentPid]
	const receipt: HostCaptureClosure = {
		schemaVersion: 1,
		scope: "observed-owned-host-process-family",
		observedAt: new Date().toISOString(),
		cleanupVerified: false,
		source: input.previousCleanupVerified === true ? "prior-owned-tree-cleanup" : "process-snapshot",
		ownedPids: [...new Set(pids.filter((pid): pid is number => Number.isSafeInteger(pid) && Number(pid) > 0))],
		matchingProcessIds: [],
		unavailableCommandLines: 0,
	}
	if (!input.hostExitObserved) return { ...receipt, failure: "host-not-closed" }
	if (input.previousCleanupVerified === false) return { ...receipt, failure: "prior-cleanup-unverified" }
	if (input.previousCleanupVerified === true) return { ...receipt, cleanupVerified: true }
	try {
		const platform = input.platform ?? process.platform
		const absolute =
			platform === "win32" ? path.win32.isAbsolute(input.userDataDir) : path.posix.isAbsolute(input.userDataDir)
		if (
			!absolute ||
			input.userDataDir.includes("\0") ||
			pids.some((pid) => !Number.isSafeInteger(pid) || Number(pid) <= 0)
		)
			throw new Error("Owned process identity unavailable")
		const snapshot = await readSnapshot()
		if (!Array.isArray(snapshot) || snapshot.length === 0 || snapshot.length > 20_000)
			throw new Error("Process snapshot unavailable")
		const seen = new Set<number>()
		let commandBytes = 0
		for (const row of snapshot) {
			if (
				!row ||
				!Number.isSafeInteger(row.pid) ||
				row.pid < 0 ||
				!Number.isSafeInteger(row.ppid) ||
				row.ppid < 0 ||
				seen.has(row.pid) ||
				(row.commandLine !== null && typeof row.commandLine !== "string") ||
				(row.processGroupId !== undefined &&
					(!Number.isSafeInteger(row.processGroupId) || row.processGroupId < 0))
			)
				throw new Error("Malformed process snapshot")
			seen.add(row.pid)
			if (row.commandLine === null) receipt.unavailableCommandLines++
			else {
				commandBytes += Buffer.byteLength(row.commandLine)
				if (row.commandLine.length > 65_536 || commandBytes > 4 * 1024 * 1024)
					throw new Error("Process snapshot truncated")
			}
		}
		const family = new Set(receipt.ownedPids)
		const children = new Map<number, number[]>()
		for (const row of snapshot) {
			const entries = children.get(row.ppid) ?? []
			entries.push(row.pid)
			children.set(row.ppid, entries)
		}
		const queue = [...family]
		for (let index = 0; index < queue.length; index++) {
			for (const child of children.get(queue[index]!) ?? []) {
				if (family.has(child)) continue
				family.add(child)
				queue.push(child)
			}
		}
		for (const row of snapshot) {
			if (
				family.has(row.pid) ||
				(platform !== "win32" && row.processGroupId === input.launchedHostPid) ||
				(row.commandLine !== null && profileMatch(row.commandLine, input.userDataDir, platform))
			)
				receipt.matchingProcessIds.push(row.pid)
		}
		receipt.matchingProcessIds.sort((left, right) => left - right)
		if (receipt.matchingProcessIds.length) return { ...receipt, failure: "owned-process-remains" }
		return { ...receipt, cleanupVerified: true }
	} catch {
		return { ...receipt, failure: "process-proof-unavailable" }
	}
}
