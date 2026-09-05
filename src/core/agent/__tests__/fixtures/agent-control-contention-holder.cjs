/* global require, process, console */

const fs = require("node:fs/promises")
const path = require("node:path")

// Model an independently running host using the immutable process-owned protocol.
// The parent terminates this process to exercise actual PID liveness and recovery.
process.on("message", () => {})

async function hold() {
	const lockPath = process.argv[2]
	await fs.mkdir(lockPath)
	await fs.writeFile(
		path.join(lockPath, "owner.json"),
		JSON.stringify({ token: "cross-process-holder", pid: process.pid }),
		{ encoding: "utf8", flag: "wx" },
	)
	process.send("ready")
}

hold().catch((error) => {
	console.error(error)
	process.exit(1)
})
