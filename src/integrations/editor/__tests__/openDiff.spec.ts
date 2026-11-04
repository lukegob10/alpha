const { executeCommand, parseUri, tabGroups } = vi.hoisted(() => ({
	executeCommand: vi.fn(),
	tabGroups: { activeTabGroup: { activeTab: undefined as { input: unknown } | undefined } },
	parseUri: vi.fn((value: string) => ({
		value,
		with: vi.fn(({ query }: { query: string }) => ({ value, query })),
	})),
}))

vi.mock("vscode", () => ({
	commands: { executeCommand },
	Uri: { parse: parseUri },
	window: { tabGroups },
	TabInputWebview: class {
		constructor(public viewType: string) {}
	},
}))

import { TabInputWebview } from "vscode"
import { Package } from "../../../shared/package"

import { openDiff } from "../openDiff"

describe("openDiff", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		executeCommand.mockReset()
		tabGroups.activeTabGroup = { activeTab: undefined }
	})

	it("opens one captured file with vscode.diff", async () => {
		await openDiff({
			title: "Alpha Diff: src/file.ts",
			files: [{ path: "src/file.ts", originalContent: "old\n", finalContent: "new\n" }],
		})

		expect(executeCommand).toHaveBeenCalledTimes(1)
		const [command, original, modified, title, options] = executeCommand.mock.calls[0]!
		expect(command).toBe("vscode.diff")
		expect(original.value).toBe("alpha-diff:/conversation/0/src/file.ts")
		expect(modified.value).toBe(original.value)
		expect(modified.query).not.toBe(original.query)
		expect(original.query).toBe(Buffer.from("old\n", "utf8").toString("base64"))
		expect(modified.query).toBe(Buffer.from("new\n", "utf8").toString("base64"))
		expect(title).toBe("Alpha Diff: src/file.ts")
		expect(options).toEqual({ preserveFocus: false, preview: false })
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
		expect(changes[0][0].value).toBe("alpha-diff:/src/one.ts")
		expect(changes[0][1].query).toBe(Buffer.from("one\n", "utf8").toString("base64"))
		expect(changes[0][2].query).toBe(Buffer.from("ONE\n", "utf8").toString("base64"))
	})
	it("opens saved patches as read-only virtual documents without inventing snapshots", async () => {
		await openDiff({ title: "Alpha Diff: legacy.ts", patch: { path: "../legacy.ts", content: "-old\n+new" } })
		const [command, resource, options, title] = executeCommand.mock.calls[0]!
		expect(command).toBe("vscode.open")
		expect(resource.value).toMatch(/^alpha-diff:/)
		expect(Buffer.from(resource.query, "base64").toString()).toBe("-old\n+new")
		expect(options).toEqual({ preserveFocus: false, preview: false })
		expect(title).toBe("Alpha Diff: legacy.ts")
	})

	it.each([
		{ hasRightGroup: true, prefix: "" },
		{ hasRightGroup: false, prefix: "" },
		{ hasRightGroup: true, prefix: "mainThreadWebview-" },
		{ hasRightGroup: false, prefix: "mainThreadWebview-" },
	])("opens beside an editor chat, reusing a right group when available (%s)", async ({ hasRightGroup, prefix }) => {
		const chatGroup = { activeTab: { input: new TabInputWebview(`${prefix}${Package.name}.TabPanelProvider`) } }
		tabGroups.activeTabGroup = chatGroup
		executeCommand.mockImplementation(async (command: string) => {
			if (hasRightGroup && command === "workbench.action.focusRightGroupWithoutWrap") {
				tabGroups.activeTabGroup = { activeTab: undefined }
			}
		})
		await openDiff({ files: [{ path: "file.ts", originalContent: "a", finalContent: "b" }] })
		expect(executeCommand.mock.calls.map(([command]) => command)).toEqual([
			"workbench.action.focusRightGroupWithoutWrap",
			...(hasRightGroup ? [] : ["workbench.action.newGroupRight"]),
			"vscode.diff",
		])
	})

	it("does not split ordinary editor groups for repeated sidebar reviews", async () => {
		tabGroups.activeTabGroup = { activeTab: { input: { uri: "file:///example.ts" } } }
		for (let index = 0; index < 2; index++) {
			await openDiff({ files: [{ path: "file.ts", originalContent: "a", finalContent: "b" }] })
		}
		expect(executeCommand.mock.calls.map(([command]) => command)).toEqual(["vscode.diff", "vscode.diff"])
	})
})
