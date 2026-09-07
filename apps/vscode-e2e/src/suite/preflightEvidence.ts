import * as fs from "fs/promises"
import { randomUUID } from "crypto"

const MAX_FAILURE_LOCATIONS = 3
const MAX_STACK_LINES = 64
const MAX_STACK_BYTES = 16 * 1024
const MAX_SOURCE_COORDINATE = 10_000_000
const SAFE_ERROR_TYPES = new Set([
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"URIError",
	"EvalError",
	"AggregateError",
	"AssertionError",
	"TestRunError",
])

export type FailureOrigin = "copilot-extension" | "alpha-extension" | "vscode" | "e2e-suite" | "runtime" | "unknown"

export type FailureLocation = {
	origin: FailureOrigin
	file: string
	line?: number
	column?: number
}

export type MochaFailureDiagnostic = {
	runnable: "test" | "hook" | "uncaught" | "unknown"
	errorType: string
	origin: FailureOrigin
	locations: FailureLocation[]
}

type RunnableLike = {
	type?: unknown
	file?: unknown
}

export type AtomicWriteDependencies = {
	writeFile?: (
		filePath: string,
		content: string,
		options: { encoding: "utf8"; flag: "wx"; mode: number },
	) => Promise<void>
	rename?: (oldPath: string, newPath: string) => Promise<void>
	unlink?: (filePath: string) => Promise<void>
}

function safeProperty(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") return undefined
	try {
		return (value as Record<string, unknown>)[key]
	} catch {
		return undefined
	}
}

function safeErrorType(error: unknown): string {
	const name = safeProperty(error, "name")
	return typeof name === "string" && SAFE_ERROR_TYPES.has(name) ? name : "unknown"
}

function originForPath(value: string): FailureOrigin {
	const normalized = value.toLowerCase().replaceAll("\\", "/")
	if (/(^|\/)(?:copilot|copilot-chat)(?:\/|$)/.test(normalized) || normalized.includes("copilot-chat")) {
		return "copilot-extension"
	}
	if (
		normalized.includes("/resources/app/") ||
		normalized.includes("/out/vs/") ||
		/\/node_modules\/(?:@vscode\/)?vscode(?:\/|$)/.test(normalized)
	) {
		return "vscode"
	}
	if (/(^|\/)vscode-e2e(?:\/|$)/.test(normalized) || normalized.includes("/apps/vscode-e2e/")) {
		return "e2e-suite"
	}
	if (
		!normalized.includes("/node_modules/") &&
		(normalized.includes("alpha-code") || /(^|\/)src\/.*(?:extension|core)(?:\/|$)/.test(normalized))
	) {
		return "alpha-extension"
	}
	if (normalized.startsWith("node:") || normalized.includes("/node_modules/")) return "runtime"
	return "unknown"
}

function safeFile(value: string, origin: FailureOrigin): string {
	const normalized = value
		.replace(/^file:\/\//i, "")
		.replaceAll("\\", "/")
		.toLowerCase()
	if (origin === "copilot-extension") {
		return /(?:^|\/)(?:copilot|copilot-chat)\/dist\/extension\.js$/.test(normalized)
			? "copilot/dist/extension.js"
			: "copilot-extension"
	}
	if (origin === "alpha-extension") {
		return /(?:^|\/)dist\/extension\.js$/.test(normalized) ? "alpha/dist/extension.js" : "alpha-extension"
	}
	if (origin === "vscode") return "vscode-runtime"
	if (origin === "runtime") return "node-runtime"
	if (origin === "e2e-suite") {
		if (/(?:^|\/)suite\/index\.js$/.test(normalized)) return "e2e-suite-entry"
		if (/(?:^|\/)suite\/workflow\.test\.js$/.test(normalized)) return "e2e-workflow"
		if (/(?:^|\/)suite\/extension\.test\.js$/.test(normalized)) return "e2e-extension"
		if (/(?:^|\/)suite\/modes\.test\.js$/.test(normalized)) return "e2e-modes"
		return "e2e-suite"
	}
	return "unknown"
}

function parseStackLocations(stack: string): FailureLocation[] {
	const locations: FailureLocation[] = []
	for (const line of stack.slice(0, MAX_STACK_BYTES).split(/\r?\n/).slice(0, MAX_STACK_LINES)) {
		if (!line.trimStart().startsWith("at ")) continue
		const coordinates = /:(\d+):(\d+)\)?\s*$/.exec(line)
		if (!coordinates || coordinates.index === undefined) continue
		const lineNumber = Number(coordinates[1])
		const columnNumber = Number(coordinates[2])
		if (
			!Number.isSafeInteger(lineNumber) ||
			!Number.isSafeInteger(columnNumber) ||
			lineNumber < 1 ||
			columnNumber < 1 ||
			lineNumber > MAX_SOURCE_COORDINATE ||
			columnNumber > MAX_SOURCE_COORDINATE
		)
			continue
		const prefix = line
			.slice(0, coordinates.index)
			.trim()
			.replace(/^at\s+/i, "")
		const openingParenthesis = prefix.lastIndexOf(" (")
		const resource = (openingParenthesis >= 0 ? prefix.slice(openingParenthesis + 2) : prefix).trim()
		if (!resource) continue
		const origin = originForPath(resource)
		const location: FailureLocation = {
			origin,
			file: safeFile(resource, origin),
			line: lineNumber,
			column: columnNumber,
		}
		const key = `${location.origin}:${location.file}:${location.line}:${location.column}`
		if (!locations.some((entry) => `${entry.origin}:${entry.file}:${entry.line}:${entry.column}` === key))
			locations.push(location)
	}
	return locations
}

function readErrorStack(error: unknown): string | undefined {
	const stack = safeProperty(error, "stack")
	return typeof stack === "string" ? stack : undefined
}

/** Keep Mocha failures useful without retaining titles, messages, paths, or provider payloads. */
export function summarizeMochaFailure(runnable: RunnableLike, error: unknown): MochaFailureDiagnostic {
	const stackLocations = parseStackLocations(readErrorStack(error) ?? "")
	let fallback: FailureLocation | undefined
	const runnableFile = safeProperty(runnable, "file")
	if (typeof runnableFile === "string" && runnableFile.length > 0) {
		const origin = originForPath(runnableFile)
		fallback = { origin, file: safeFile(runnableFile, origin) }
	}
	const allLocations = stackLocations.length > 0 ? stackLocations : fallback ? [fallback] : []
	const runnableType = safeProperty(runnable, "type")
	const uncaught = safeProperty(error, "uncaught") === true
	const runnableKind = uncaught
		? "uncaught"
		: runnableType === "hook"
			? "hook"
			: runnableType === "test"
				? "test"
				: "unknown"
	const nonRuntimeLocations = allLocations.filter((location) => location.origin !== "runtime")
	const locations = (nonRuntimeLocations.length > 0 ? nonRuntimeLocations : fallback ? [fallback] : []).slice(
		0,
		MAX_FAILURE_LOCATIONS,
	)
	return {
		runnable: runnableKind,
		errorType: safeErrorType(error),
		origin: locations[0]?.origin ?? "unknown",
		locations,
	}
}

function serialize(value: unknown): string {
	const encoded = JSON.stringify(value, null, 2)
	if (encoded === undefined) throw new Error("JSON evidence value is required")
	return `${encoded}\n`
}

function temporaryPath(target: string): string {
	return `${target}.${process.pid}.${randomUUID()}.tmp`
}

async function writeTextAtomically(
	target: string,
	content: string,
	dependencies: AtomicWriteDependencies = {},
): Promise<void> {
	const temporary = temporaryPath(target)
	const writeFile =
		dependencies.writeFile ??
		(async (filePath: string, value: string, options: { encoding: "utf8"; flag: "wx"; mode: number }) => {
			await fs.writeFile(filePath, value, options)
		})
	const rename = dependencies.rename ?? fs.rename
	const unlink = dependencies.unlink ?? fs.unlink
	let writeCompleted = false
	try {
		await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 })
		writeCompleted = true
		await rename(temporary, target)
	} finally {
		// A failed exclusive create may have targeted a pre-existing temp file. Only clean up after our write succeeded.
		if (writeCompleted) await unlink(temporary).catch(() => undefined)
	}
}

export async function writeJsonAtomically(
	target: string,
	value: unknown,
	dependencies: AtomicWriteDependencies = {},
): Promise<void> {
	await writeTextAtomically(target, serialize(value), dependencies)
}

/** Queue state snapshots so concurrent lifecycle updates cannot reorder or truncate the receipt. */
export function createSerializedJsonWriter(
	target: string,
	dependencies: AtomicWriteDependencies = {},
): (value: unknown) => Promise<void> {
	let pending: Promise<void> = Promise.resolve()
	return (value: unknown) => {
		let content: string
		try {
			content = serialize(value)
		} catch (error) {
			const failed = pending.then(() => {
				throw error
			})
			pending = failed.catch(() => undefined)
			return failed
		}
		const write = pending.then(() => writeTextAtomically(target, content, dependencies))
		pending = write.catch(() => undefined)
		return write
	}
}
