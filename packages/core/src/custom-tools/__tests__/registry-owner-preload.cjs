// Diagnostic-only observer; compiler commands and registry bundle bytes remain unchanged.
/* global require, process, module, setTimeout, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports -- Node --require loads this fixture before ESM linking. */
const fs = require("node:fs")
const path = require("node:path")
const childProcess = require("node:child_process")
const { syncBuiltinESMExports } = require("node:module")

const directory = process.env.ALPHA_REGISTRY_PROCESS_TRACE_DIR
const file = path.join(directory, `${process.pid}.owner.json`)
const events = new Array(512)
const children = new Map()
let total = 0
let nextSpawn = 0
let snapshotTimer
function stage(stage, value) {
	events[total++ % events.length] = [Date.now(), stage, value ?? ""]
}
function streamState(stream) {
	return (
		stream && {
			readableLength: stream.readableLength,
			readableEnded: stream.readableEnded,
			readableFlowing: stream.readableFlowing,
			writableLength: stream.writableLength,
			writableEnded: stream.writableEnded,
			destroyed: stream.destroyed,
		}
	)
}
function procState(pid) {
	const read = (file) => {
		try {
			return fs.readFileSync(file, "utf8").slice(0, 4096).trim()
		} catch (error) {
			return { code: error.code ?? "UNKNOWN" }
		}
	}
	const root = `/proc/${pid}`
	const status = read(`${root}/status`)
	const result = {
		stat: read(`${root}/stat`),
		status:
			typeof status === "string"
				? status
						.split("\n")
						.filter((line) =>
							/^(State|Pid|PPid|Threads|VmRSS|VmSize|voluntary_ctxt_switches|nonvoluntary_ctxt_switches):/.test(
								line,
							),
						)
				: status,
	}
	try {
		const threads = fs.readdirSync(`${root}/task`).filter((name) => /^[0-9]+$/.test(name))
		result.threadsTruncated = threads.length > 32
		result.threads = threads
			.slice(0, 32)
			.map((tid) => ({ tid, stat: read(`${root}/task/${tid}/stat`), wchan: read(`${root}/task/${tid}/wchan`) }))
	} catch (error) {
		result.threads = { code: error.code ?? "UNKNOWN" }
	}
	return result
}
function captureNativeStack(child, launch = childProcess.spawnSync) {
	const record = [...children.values()].find((record) => record.child === child)
	const pid = child?.pid
	if (!record || !Number.isSafeInteger(pid) || pid <= 1 || child.exitCode !== null || child.signalCode !== null)
		throw new Error("Native stack target must be a live owned child")
	const owner = () => {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
			return Number(/^\d+ \(.+\) \S (\d+) /.exec(stat)?.[1]) === process.pid
		} catch {
			return false
		}
	}
	if (!owner()) return { code: "CHILD_NO_LONGER_OWNED" }
	const stackFile = path.join(directory, `${process.pid}.compiler-${record.id}-${pid}.gdb.txt`)
	const started = Date.now()
	let result
	try {
		// Bound the elevated debugger itself; killing only sudo may leave its child attached.
		result = launch(
			"sudo",
			[
				"-n",
				"timeout",
				"--signal=TERM",
				"--kill-after=1s",
				"3s",
				"gdb",
				"--batch",
				"--nx",
				"--nh",
				"-iex",
				"set auto-load off",
				"-iex",
				"set debuginfod enabled off",
				"-iex",
				"set print frame-arguments none",
				"--pid",
				String(pid),
				"-ex",
				"set pagination off",
				"-ex",
				"thread apply all bt 30",
				"-ex",
				"detach",
			],
			{
				cwd: directory,
				env: { ...process.env, DEBUGINFOD_URLS: "" },
				stdio: ["ignore", "pipe", "pipe"],
				timeout: 6_000,
				maxBuffer: 256 * 1024,
				killSignal: "SIGKILL",
			},
		)
	} catch (error) {
		result = { error: { code: error.code ?? "UNKNOWN" } }
	} finally {
		// A failed debugger must not leave the owned compiler stopped by ptrace.
		if (owner()) {
			try {
				process.kill(pid, "SIGCONT")
			} catch (error) {
				if (error.code !== "ESRCH") stage("debugger resume error", error.code ?? "UNKNOWN")
			}
		}
	}
	const bytes = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? "")))
	const output = Buffer.concat([bytes(result.stdout), bytes(result.stderr)]).subarray(0, 256 * 1024)
	fs.writeFileSync(stackFile, output)
	return {
		file: path.basename(stackFile),
		bytes: output.length,
		status: result.status,
		signal: result.signal,
		code: result.error?.code,
		elapsedMs: Date.now() - started,
	}
}
function flush(phase) {
	const start = Math.max(0, total - events.length)
	let inspected = 0
	let stackAttempts = 0
	const snapshot = {
		phase,
		at: Date.now(),
		pid: process.pid,
		ppid: process.ppid,
		uptime: process.uptime(),
		total,
		resources: process.getActiveResourcesInfo(),
		cpu: process.cpuUsage(),
		children: [...children.values()].map(({ child, id, command, args }) => ({
			id,
			pid: child.pid,
			command,
			args,
			exitCode: child.exitCode,
			signalCode: child.signalCode,
			killed: child.killed,
			stdin: streamState(child.stdin),
			stdout: streamState(child.stdout),
			stderr: streamState(child.stderr),
			proc:
				phase === "deadline snapshot" &&
				process.platform === "linux" &&
				child.pid &&
				child.exitCode === null &&
				child.signalCode === null
					? ++inspected <= 4
						? procState(child.pid)
						: { code: "LIVE_PROCESS_LIMIT" }
					: undefined,
			nativeStack:
				phase === "deadline snapshot" &&
				process.env.ALPHA_CUSTOM_TOOL_NATIVE_STACKS === "1" &&
				process.platform === "linux" &&
				child.pid &&
				child.exitCode === null &&
				child.signalCode === null &&
				++stackAttempts <= 1
					? captureNativeStack(child)
					: undefined,
		})),
		events: Array.from(
			{ length: Math.min(total, events.length) },
			(_, index) => events[(start + index) % events.length],
		),
	}
	fs.writeFileSync(file, JSON.stringify(snapshot))
}
const originalSpawn = childProcess.spawn
childProcess.spawn = function (...args) {
	const child = Reflect.apply(originalSpawn, this, args)
	const id = ++nextSpawn
	if (children.size >= 128) {
		stage("observer history truncated", children.keys().next().value)
		children.delete(children.keys().next().value)
	}
	children.set(id, { child, id, command: args[0], args: Array.isArray(args[1]) ? args[1].slice() : [] })
	stage("compiler created", { id, pid: child.pid })
	child.on("spawn", () => stage("compiler spawn", { id, pid: child.pid }))
	child.on("exit", (code, signal) => stage("compiler exit", { id, pid: child.pid, code, signal }))
	child.on("close", (code, signal) => stage("compiler close", { id, pid: child.pid, code, signal }))
	child.on("error", (error) => stage("compiler error", { id, pid: child.pid, name: error.name, code: error.code }))
	child.stdout?.on("end", () => stage("compiler stdout end", { id, pid: child.pid }))
	child.stderr?.on("end", () => stage("compiler stderr end", { id, pid: child.pid }))
	return child
}
syncBuiltinESMExports()
globalThis.__alphaRegistryProcessStage = stage
stage("owner preload", { executable: process.execPath, entry: process.argv[1] ?? "eval" })
fs.mkdirSync(directory, { recursive: true })
flush("preload")
const snapshotAt = Number(process.env.ALPHA_REGISTRY_PROCESS_SNAPSHOT_AT)
function armSnapshot(at) {
	if (snapshotTimer) throw new Error("Observer snapshot already armed")
	snapshotTimer = setTimeout(
		() => {
			stage("deadline snapshot")
			flush("deadline snapshot")
		},
		Math.max(1, at - Date.now()),
	).unref()
}
if (Number.isFinite(snapshotAt)) armSnapshot(snapshotAt)
module.exports = { armSnapshot, captureNativeStack }
process.on("beforeExit", (code) => {
	stage("beforeExit", code)
	flush("beforeExit")
})
process.on("exit", (code) => {
	stage("exit", code)
	flush("exit")
})
process.on("uncaughtExceptionMonitor", (error) => {
	stage("uncaught", { name: error.name, message: error.message })
	flush("uncaught")
})
