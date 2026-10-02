import { parentPort } from "node:worker_threads"

parentPort.on("message", ({ gate, ready }) => {
	ready.postMessage("started")
	Atomics.wait(new Int32Array(gate), 0, 0)
})
