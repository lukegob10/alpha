import { describe, expect, it } from "vitest"

import { resolveGraderAlias } from "../catalog"
import { validateGraderSpec } from "../validation"
import type { CommandGraderSpec, GraderSpec } from "../types"

const command: CommandGraderSpec = {
	id: "owned-tests",
	version: 1,
	type: "command",
	hardGate: true,
	failureClass: "outcome",
	commands: [{ command: "node", args: ["--test", "test/behavior.test.js"] }],
	cwd: "workspace",
	timeoutMs: 1_000,
	maxOutputBytes: 4_096,
}

function contracted(expectedTests: Array<{ file: string; name: string; assertions: number }>): CommandGraderSpec {
	return {
		...command,
		commands: [{ ...command.commands[0]!, testExecution: { runner: "node-test", expectedTests } }],
	}
}

describe("grader execution contracts", () => {
	it.each([
		{ ...command, maxOutputByte: 1 },
		{ ...command, commands: [{ ...command.commands[0]!, testExection: { runner: "node-test" } }] },
		{
			...command,
			commands: [
				{
					...command.commands[0]!,
					testExecution: {
						runner: "node-test",
						expectedTests: [{ file: "test/behavior.test.js", name: "checks", assertions: 1, skip: true }],
					},
				},
			],
		},
		{
			id: "final-state",
			version: 1,
			hardGate: true,
			failureClass: "outcome",
			type: "filesystem",
			assertions: [{ kind: "exists", path: "result.txt", expected: "correct" }],
		},
		{
			id: "scoped-changes",
			version: 1,
			hardGate: true,
			failureClass: "outcome",
			type: "diff-policy",
			allowed: ["src/**"],
			maxChangedFile: 0,
		},
		{
			id: "source-check",
			version: 1,
			hardGate: true,
			failureClass: "outcome",
			type: "static-analysis",
			files: [{ path: "src/result.js", forbiddenPattern: "unsafe" }],
		},
	])("rejects unknown criterion keys rather than silently weakening $type", (spec) => {
		expect(() => validateGraderSpec(spec as GraderSpec)).toThrow("Invalid or empty grader criteria")
	})

	it("projects captured Node test metadata into the owning command grader without widening trace criteria", () => {
		const prepared = contracted([{ file: "test/behavior.test.js", name: "checks", assertions: 1 }]).commands
		const visible = resolveGraderAlias({ alias: "visible_tests", taskId: "task", visibleCommands: prepared })
		const trace = resolveGraderAlias({ alias: "validation_after_edit", taskId: "task", visibleCommands: prepared })
		expect(() => validateGraderSpec(visible)).not.toThrow()
		expect(() => validateGraderSpec(trace)).not.toThrow()
		expect(visible).toMatchObject({ commands: prepared })
		expect(trace).toMatchObject({
			assertions: [{ kind: "verification-after-last-mutation", commands: command.commands }],
		})
	})

	it("retains legacy command specs while admitting explicit expected assertion execution", () => {
		expect(() => validateGraderSpec(command)).not.toThrow()
		expect(() =>
			validateGraderSpec(
				contracted([{ file: "test/behavior.test.js", name: "checks the result", assertions: 2 }]),
			),
		).not.toThrow()
	})

	it.each([
		"../outside.js",
		"/absolute.js",
		"C:/outside.js",
		"test\\behavior.js",
		"test//file.js",
		"./test.js",
		"a/../b.js",
		"a\u0000.js",
	])("rejects noncanonical or escaping expected test path %s", (file) => {
		expect(() => validateGraderSpec(contracted([{ file, name: "checks", assertions: 1 }]))).toThrow()
	})

	it("rejects absent assertion plans and ambiguous duplicate test identities", () => {
		expect(() => validateGraderSpec(contracted([]))).toThrow()
		for (const assertions of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
			expect(() =>
				validateGraderSpec(contracted([{ file: "test/behavior.test.js", name: "checks", assertions }])),
			).toThrow()
		}
		const expected = { file: "test/behavior.test.js", name: "checks", assertions: 1 }
		expect(() => validateGraderSpec(contracted([expected, expected]))).toThrow()
	})

	it("binds supplied original source digests to exactly the selected test files", () => {
		const spec = contracted([{ file: "test/behavior.test.js", name: "checks", assertions: 1 }])
		const execution = spec.commands[0]!.testExecution!
		execution.sourceDigests = [{ file: "test/behavior.test.js", digest: `sha256:${"a".repeat(64)}` }]
		expect(() => validateGraderSpec(spec)).not.toThrow()
		for (const sourceDigests of [
			[],
			[{ file: "../other.js", digest: `sha256:${"a".repeat(64)}` }],
			[{ file: "test/other.js", digest: `sha256:${"a".repeat(64)}` }],
			[{ file: "test/behavior.test.js", digest: "sha256:bad" }],
			[...execution.sourceDigests, ...execution.sourceDigests],
		]) {
			execution.sourceDigests = sourceDigests
			expect(() => validateGraderSpec(spec)).toThrow()
		}
	})

	it("requires nonempty required-verifier criteria while retaining semantic verification without a command list", () => {
		const trace: GraderSpec = {
			id: "verification",
			version: 1,
			type: "trace-assertion",
			hardGate: true,
			failureClass: "outcome",
			assertions: [{ kind: "verification-after-last-mutation" }],
		}
		expect(() => validateGraderSpec(trace)).not.toThrow()
		expect(() =>
			validateGraderSpec({
				...trace,
				assertions: [{ kind: "verification-after-last-mutation", commands: [] }],
			}),
		).toThrow()
	})
})
