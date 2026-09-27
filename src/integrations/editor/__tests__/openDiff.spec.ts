const { executeCommand, parseUri } = vi.hoisted(() => ({
	executeCommand: vi.fn(),
	parseUri: vi.fn((value: string) => ({
		value,
		with: vi.fn(({ query }: { query: string }) => ({ value, query })),
	})),
}))

vi.mock("vscode", () => ({
	commands: { executeCommand },
	Uri: { parse: parseUri },
}))

vi.mock("../DiffViewProvider", () => ({
	DIFF_VIEW_URI_SCHEME: "cline-diff",
}))

import { openDiff } from "../openDiff"

describe("openDiff", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("opens one captured file with vscode.diff", async () => {
		await openDiff({
			title: "Alpha Diff: src/file.ts",
			files: [{ path: "src/file.ts", originalContent: "old\n", finalContent: "new\n" }],
		})

		expect(executeCommand).toHaveBeenCalledTimes(1)
		const [command, original, modified, title, options] = executeCommand.mock.calls[0]!
		expect(command).toBe("vscode.diff")
		expect(original.query).toBe(Buffer.from("old\n", "utf8").toString("base64"))
		expect(modified.query).toBe(Buffer.from("new\n", "utf8").toString("base64"))
		expect(title).toBe("Alpha Diff: src/file.ts")
		expect(options).toEqual({ preserveFocus: false })
	})

	it("opens a multi-file change set with vscode.changes", async () => {
		await openDiff({
			files: [
				{ path: "src/one.ts", originalContent: "one\n", finalContent: "ONE\n" },
				{ path: "src/two.ts", originalContent: "two\n", finalContent: "TWO\n" },
			],
		})

		expect(executeCommand).toHaveBeenCalledTimes(1)
		const [command, title, changes] = executeCommand.mock.calls[0]!
		expect(command).toBe("vscode.changes")
		expect(title).toBe("Alpha Diff")
		expect(changes).toHaveLength(2)
		expect(changes[0][0].value).toBe("cline-diff:/src/one.ts")
		expect(changes[0][1].query).toBe(Buffer.from("one\n", "utf8").toString("base64"))
		expect(changes[0][2].query).toBe(Buffer.from("ONE\n", "utf8").toString("base64"))
	})
})
