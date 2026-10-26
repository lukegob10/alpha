import * as path from "node:path"
import * as fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import type { CommandGraderSpec } from "./types"

type ExpectedTest = NonNullable<CommandGraderSpec["commands"][number]["testExecution"]>["expectedTests"][number]

export async function captureExpectedNodeTestCommands(
	fixtureRoot: string,
	commands: Array<{ command: string; args: string[] }>,
): Promise<CommandGraderSpec["commands"]> {
	const prepared: CommandGraderSpec["commands"] = []
	for (const command of commands) {
		if (!["node", "node.exe", process.execPath].includes(command.command) || command.args[0] !== "--test") {
			prepared.push({ ...command, args: [...command.args] })
			continue
		}
		if (command.args.length < 2 || command.args.slice(1).some((file) => file.startsWith("-") || /[*?]/.test(file)))
			throw new Error("Node acceptance needs an explicit original test file selection")
		const root = await fs.realpath(fixtureRoot)
		const expectedTests: ExpectedTest[] = []
		const sourceDigests: Array<{ file: string; digest: string }> = []
		for (const file of [...new Set(command.args.slice(1))]) {
			const absolute = containedFile(root, file)
			const real = await fs.realpath(absolute)
			if (real !== absolute || !(await fs.lstat(absolute)).isFile())
				throw new Error("Original Node test selection cannot contain symbolic links")
			const bytes = await fs.readFile(absolute)
			expectedTests.push(...captureNodeTestAssertions(file, bytes.toString("utf8")))
			sourceDigests.push({ file, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` })
		}
		prepared.push({
			...command,
			args: [...command.args],
			testExecution: { runner: "node-test", expectedTests, sourceDigests },
		})
	}
	return prepared
}

/** Capture the static, named fixture checks before any agent can edit the workspace. */
export function captureNodeTestAssertions(file: string, source: string): ExpectedTest[] {
	// The local fixture contract uses named test()/it() callbacks and direct
	// node:assert/strict calls. Ignore comments and literals rather than counting
	// source substrings; dynamic test factories need an explicit authored contract.
	const tokens = fixtureTokens(source)
	const expected: ExpectedTest[] = []
	for (let index = 0; index < tokens.length; index++) {
		if (!["test", "it"].includes(tokens[index]!) || tokens[index - 1] === ".") continue
		let start = index + 1
		if (tokens[start] === "." && ["skip", "todo", "only"].includes(tokens[start + 1]!)) start += 2
		if (tokens[start] !== "(") continue
		const nameToken = tokens[start + 1]!
		if (!nameToken?.startsWith('"')) throw new Error(`Fixture needs an explicit named assertion contract: ${file}`)
		const name = JSON.parse(nameToken) as string
		let depth = 1
		let assertions = 0
		let end = start + 1
		for (; end < tokens.length && depth > 0; end++) {
			if (tokens[end] === "(") depth++
			else if (tokens[end] === ")") depth--
			if (
				tokens[end] === "assert" &&
				(tokens[end + 1] === "(" ||
					(tokens[end + 1] === "." && tokens[end + 2] !== "fail" && tokens[end + 3] === "("))
			)
				assertions++
		}
		if (depth !== 0 || assertions === 0 || expected.some((test) => test.name === name))
			throw new Error(`Fixture needs a nonempty unambiguous assertion contract: ${file}`)
		expected.push({ file, name, assertions })
		index = end - 1
	}
	if (!expected.length) throw new Error(`Fixture contains no independently identifiable assertions: ${file}`)
	return expected
}

function fixtureTokens(source: string): string[] {
	const tokenPattern =
		/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g
	const tokens: string[] = []
	let match: RegExpExecArray | null
	while ((match = tokenPattern.exec(source))) {
		const token = match[0]
		if (token.startsWith("//") || token.startsWith("/*")) continue
		if (
			token === "/" &&
			[undefined, "=", "(", ",", ":", "[", "!", "?", ";", "return", ">"].includes(tokens.at(-1))
		) {
			let inClass = false
			let closed = false
			for (let position = tokenPattern.lastIndex; position < source.length; position++) {
				const character = source[position]
				if (character === "\\") position++
				else if (character === "[") inClass = true
				else if (character === "]") inClass = false
				else if (character === "/" && !inClass) {
					tokenPattern.lastIndex = position + 1
					closed = true
					break
				} else if (character === "\n" || character === "\r") break
			}
			if (!closed) throw new Error("Fixture contains unsupported regular-expression syntax")
			tokens.push("<regexp>")
			continue
		}
		tokens.push(token)
	}
	return tokens
}

const receiptSchema = z.object({
	schemaVersion: z.literal(1),
	kind: z.literal("alpha-expected-node-tests"),
	complete: z.literal(true),
	failed: z.boolean(),
	timedOut: z.boolean(),
	tests: z.array(
		z.object({ file: z.string(), name: z.string(), passed: z.boolean(), skipped: z.boolean(), todo: z.boolean() }),
	),
	completions: z.array(
		z.object({ kind: z.literal("alpha-original-assertions"), file: z.string(), name: z.string() }),
	),
	assertionFailures: z
		.array(z.object({ file: z.string(), name: z.string(), code: z.literal("ERR_ASSERTION"), message: z.string() }))
		.default([]),
})

export function nodeTestCompletionCommand(
	command: CommandGraderSpec["commands"][number],
	cwd: string,
	timeoutMs: number,
): { command: string; args: string[] } {
	const contract = command.testExecution!
	const files = [...new Set(contract.expectedTests.map(({ file }) => file))]
	if (
		!["node", "node.exe", process.execPath].includes(command.command) ||
		command.args[0] !== "--test" ||
		command.args.length !== files.length + 1 ||
		files.some((file) => !command.args.slice(1).includes(file))
	)
		throw new Error("Expected assertion contracts require direct Node test execution with exact file selection")
	const expected = contract.expectedTests.map((test) => ({ ...test, file: containedFile(cwd, test.file) }))
	const sourceDigests = contract.sourceDigests?.map((source) => ({
		...source,
		file: containedFile(cwd, source.file),
	}))
	return {
		command: process.execPath,
		args: [
			fileURLToPath(new URL("./nodeTestExecution.mjs", import.meta.url)),
			JSON.stringify({ expected, sourceDigests }),
			String(timeoutMs),
		],
	}
}

export function inspectNodeTestCompletion(
	output: string,
	expected: readonly ExpectedTest[],
	cwd: string,
): "passed" | "failed" | "error" {
	let value: unknown
	try {
		value = JSON.parse(output)
	} catch {
		return "error"
	}
	const parsed = receiptSchema.safeParse(value)
	if (!parsed.success || parsed.data.timedOut) return "error"
	if (parsed.data.failed) return "failed"
	const completed = expected.every((item) => {
		const completion = parsed.data.completions.filter(
			(test) => test.file === containedFile(cwd, item.file) && test.name === item.name,
		)
		const matches = parsed.data.tests.filter(
			(test) =>
				test.file === fileURLToPath(new URL("./nodeTestContext.cjs", import.meta.url)) &&
				test.name === item.name,
		)
		return (
			completion.length === 1 &&
			matches.length === expected.filter((test) => test.name === item.name).length &&
			matches.every((test) => test.passed && !test.skipped && !test.todo)
		)
	})
	return completed ? "passed" : "failed"
}

/** Only the trusted collector's original-assertion proof establishes an intentionally failing fixture. */
export function hasNodeTestAssertionFailure(output: string, expected: readonly ExpectedTest[]): boolean {
	let value: unknown
	try {
		value = JSON.parse(output)
	} catch {
		return false
	}
	const parsed = receiptSchema.safeParse(value)
	if (!parsed.success || parsed.data.timedOut || !parsed.data.failed) return false
	const contextFile = fileURLToPath(new URL("./nodeTestContext.cjs", import.meta.url))
	const tests = parsed.data.tests
	if (
		tests.length !== expected.length ||
		tests.some((test) => test.file !== contextFile || test.skipped || test.todo) ||
		!tests.some((test) => !test.passed)
	)
		return false
	return expected.every(
		(item) =>
			tests.filter((test) => test.name === item.name).length ===
				expected.filter((test) => test.name === item.name).length &&
			tests.filter((test) => test.name === item.name && !test.passed).length <=
				parsed.data.assertionFailures.filter(
					(failure) => failure.file === contextFile && failure.name === item.name,
				).length,
	)
}

function containedFile(cwd: string, file: string): string {
	const resolved = path.resolve(cwd, file)
	const relative = path.relative(cwd, resolved)
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
		throw new Error("Expected Node test file must be inside its grader workspace")
	return resolved
}
