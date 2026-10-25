/* global AbortSignal */
import { createRequire, registerHooks } from "node:module"
import { Buffer } from "node:buffer"
import { createHash, createHmac } from "node:crypto"
import { readFileSync, lstatSync, realpathSync } from "node:fs"
import path from "node:path"
import process from "node:process"
import { run } from "node:test"
import { fileURLToPath, pathToFileURL, URL } from "node:url"

const location = new URL(import.meta.url)
const contract = location.searchParams.get("contract")

if (contract) {
	const { expected, sourceDigests = [] } = JSON.parse(contract)
	process.env.ALPHA_EXPECTED_NODE_TESTS = JSON.stringify(expected)
	// Snapshot real assertion functions before any model-owned dependency loads.
	createRequire(import.meta.url)("./nodeTestContext.cjs")
	const files = new Set(expected.map((item) => pathToFileURL(item.file).href))
	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (files.has(context.parentURL)) {
				if (specifier === "node:test")
					return { url: new URL("./nodeTestContext.cjs", location).href, shortCircuit: true }
				if (specifier === "node:assert/strict")
					return { url: new URL("./nodeTestAssertions.cjs", location).href, shortCircuit: true }
			}
			return nextResolve(specifier, context)
		},
		load(url, context, nextLoad) {
			const source = sourceDigests.find((item) => pathToFileURL(item.file).href === url)
			const loaded = nextLoad(url, context)
			if (!source) return loaded
			const bytes = readOriginalSource(source)
			return { ...loaded, source: bytes }
		},
	})
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(location)) {
	const { expected, sourceDigests = [] } = JSON.parse(process.argv[2])
	const worker = new URL(location)
	worker.searchParams.set("contract", JSON.stringify({ expected, sourceDigests }))
	const tests = []
	const completions = []
	const assertionFailures = []
	const assertionProofs = []
	const assertionKeys = new Map()
	const workerOutput = new Map()
	const ownedFailures = []
	let diagnosticBytes = 0
	let assertionBytes = 0
	const maxEvents = expected.length * 4 + 32
	const timeoutMs = Number(process.argv[3])
	const signal = AbortSignal.timeout(Math.max(1, timeoutMs - Math.min(1000, Math.floor(timeoutMs / 10))))
	let summary
	let failed = false
	// Model stdout arrives as test:stdout data; it never enters this supervisor's
	// JSON receipt channel. Only Node's structured test events establish execution.
	for await (const event of run({
		files: [...new Set(expected.map((item) => item.file))],
		isolation: "process",
		concurrency: 1,
		execArgv: ["--import", worker.href],
		signal,
	})) {
		if (event.type === "test:stdout") {
			const file = event.data.file
			const prior = workerOutput.get(file)
			if (prior === true) process.stderr.write(event.data.message)
			else {
				const message = (prior ?? "") + event.data.message
				const newline = message.indexOf("\n")
				if (newline < 0 && Buffer.byteLength(message) <= 16_384) workerOutput.set(file, message)
				else {
					workerOutput.set(file, true)
					try {
						const initialization = JSON.parse(message.slice(0, newline))
						if (
							initialization.kind !== "alpha-original-assertion-key" ||
							!/^[a-f0-9]{64}$/.test(initialization.key) ||
							!expected.some((item) => item.file === initialization.file) ||
							(file && file !== initialization.file) ||
							assertionKeys.has(initialization.file)
						)
							throw new Error("Invalid assertion worker initialization")
						assertionKeys.set(initialization.file, Buffer.from(initialization.key, "hex"))
						process.stderr.write(message.slice(newline + 1))
					} catch {
						failed = true
					}
				}
			}
		}
		if (event.type === "test:stderr") process.stderr.write(event.data.message)
		if (event.type === "test:fail") failed = true
		if (event.type === "test:fail" && event.data.details?.error) {
			// Node wraps worker assertions in ERR_TEST_FAILURE. Preserve the actual
			// cause separately from arbitrary worker stdout, with finite traversal.
			for (const error of failureCauses(event.data.details.error)) {
				const remaining = 16_384 - diagnosticBytes
				if (remaining > 0) {
					const bytes = Buffer.from(String(error.stack ?? error) + "\n").subarray(0, remaining)
					process.stderr.write(bytes)
					diagnosticBytes += bytes.byteLength
				}
				if (
					error.code === "ERR_ASSERTION" &&
					event.data.file === fileURLToPath(new URL("./nodeTestContext.cjs", location)) &&
					expected.some(({ name }) => name === event.data.name) &&
					ownedFailures.length < Math.min(expected.length, 256)
				) {
					ownedFailures.push({
						file: event.data.file,
						name: event.data.name,
						code: "ERR_ASSERTION",
						message: Buffer.from(String(error.message)).subarray(0, 4_096).toString("utf8"),
					})
				}
			}
		}
		if (event.type === "test:diagnostic") {
			try {
				const value = JSON.parse(event.data.message)
				if (value.kind === "alpha-original-assertions") {
					if (completions.length < maxEvents) completions.push(value)
					else failed = true
				}
				if (
					value.kind === "alpha-original-assertion-failure" &&
					assertionProofs.length < Math.min(maxEvents, 256)
				) {
					const key = assertionKeys.get(value.file)
					const proof = {
						file: value.file,
						name: value.name,
						assertion: value.assertion,
						code: value.code,
						message: value.message,
					}
					if (
						key &&
						value.code === "ERR_ASSERTION" &&
						typeof value.message === "string" &&
						Buffer.byteLength(value.message) <= 4_096 &&
						/^[A-Za-z][A-Za-z0-9]*$/.test(value.assertion) &&
						expected.some((item) => item.file === value.file && item.name === value.name) &&
						createHmac("sha256", key).update(JSON.stringify(proof)).digest("hex") === value.signature
					)
						assertionProofs.push(proof)
				}
			} catch {
				// Ordinary test diagnostics are not assertion completion evidence.
			}
		}
		if (event.type === "test:pass" || event.type === "test:fail") {
			if (tests.length >= maxEvents) {
				failed = true
				continue
			}
			tests.push({
				file: event.data.file,
				name: event.data.name,
				passed: event.type === "test:pass",
				skipped: Boolean(event.data.skip),
				todo: Boolean(event.data.todo),
			})
		}
		if (event.type === "test:summary" && !event.data.file) {
			if (summary) throw new Error("Duplicate Node test collector summary")
			summary = event.data
		}
	}
	for (const proof of assertionProofs) {
		const failure = ownedFailures.find((item) => item.name === proof.name && item.message === proof.message)
		if (failure && assertionBytes + Buffer.byteLength(failure.message) <= 16_384) {
			assertionBytes += Buffer.byteLength(failure.message)
			assertionFailures.push(failure)
		}
	}
	for (const source of sourceDigests) {
		try {
			readOriginalSource(source)
		} catch {
			failed = true
		}
	}
	process.stdout.write(
		JSON.stringify({
			schemaVersion: 1,
			kind: "alpha-expected-node-tests",
			complete: Boolean(summary),
			failed: failed || summary?.success !== true,
			timedOut: signal.aborted,
			tests,
			completions,
			assertionFailures,
		}),
	)
}

function* failureCauses(error) {
	const seen = new Set()
	for (let depth = 0; error && typeof error === "object" && !seen.has(error) && depth < 8; depth++) {
		seen.add(error)
		yield error
		error = error.cause
	}
}

function readOriginalSource(source) {
	const root = realpathSync(process.cwd())
	const relative = path.relative(root, source.file)
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
		throw new Error("Original test source escaped its grading workspace")
	let current = root
	for (const segment of relative.split(path.sep)) {
		current = path.join(current, segment)
		if (lstatSync(current).isSymbolicLink()) throw new Error("Original test source cannot use symbolic links")
	}
	const bytes = readFileSync(source.file)
	if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== source.digest)
		throw new Error("Original test source differs from its independently captured identity")
	return bytes
}
