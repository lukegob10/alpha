import { spawn } from "node:child_process"
import process from "node:process"
import { setInterval } from "node:timers"

const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
	stdio: "ignore",
	windowsHide: true,
})

if (typeof child.pid !== "number") {
	throw new Error("Failed to start fixture child process")
}

process.stdout.write(`${JSON.stringify({ parentPid: process.pid, childPid: child.pid })}\n`)
setInterval(() => {}, 1_000)
