import { EventEmitter } from "events"
import * as path from "path"
import { listFiles } from "../list-files"

const { spawn, readdir, access, readFile } = vi.hoisted(() => ({
	spawn: vi.fn(),
	readdir: vi.fn(),
	access: vi.fn(),
	readFile: vi.fn(),
}))

vi.mock("child_process", () => ({ spawn }))
vi.mock("fs", () => ({ promises: { readdir, access, readFile } }))
vi.mock("../../ripgrep", () => ({ getBinPath: async () => "fixture-rg" }))
vi.mock("../../../utils/path", () => ({ arePathsEqual: () => false }))

const root = path.resolve("/discovery-workspace")
const files = Array.from({ length: 200 }, (_, index) => path.join(root, "src", `unit-${index}`, "file.ts"))
const directory = (name: string) => ({ name, isDirectory: () => true, isSymbolicLink: () => false })

beforeEach(() => {
	vi.resetAllMocks()
	vi.useFakeTimers()
	vi.setSystemTime(0)
	access.mockImplementation(async (value: string) => {
		if (value !== path.join(root, ".gitignore")) {
			throw Object.assign(new Error("Missing ignore file"), { code: "ENOENT" })
		}
	})
	readFile.mockResolvedValue("generated/\n")
	readdir.mockImplementation(async (value: string) => {
		await new Promise((resolve) => setTimeout(resolve, 2))
		if (value === root) return [directory("src"), directory("generated")]
		if (value === path.join(root, "src")) {
			return Array.from({ length: 200 }, (_, index) => directory(`unit-${index}`))
		}
		if (value === path.join(root, "generated")) {
			return Array.from({ length: 1000 }, (_, index) => directory(`artifact-${index}`))
		}
		return []
	})
	spawn.mockImplementation(() => {
		const child = Object.assign(new EventEmitter(), {
			stdout: new EventEmitter(),
			stderr: new EventEmitter(),
			kill: vi.fn(),
		})
		setTimeout(() => {
			child.stdout.emit("data", files.join("\n") + "\n")
			child.emit("close", 0)
		}, 20)
		return child
	})
})

afterEach(() => vi.useRealTimers())

it.each([true, false])("measures discovery with includeDirectories=%s", async (includeDirectories) => {
	const listing = listFiles(root, true, 50_000, undefined, { includeDirectories })
	await vi.runAllTimersAsync()
	const [paths, limited] = await listing
	const discoveredFiles = paths.filter((entry) => !entry.endsWith("/"))
	console.info("FILE_DISCOVERY_BENCHMARK", {
		includeDirectories,
		files: discoveredFiles.length,
		directoryReads: readdir.mock.calls.length,
		totalMs: Date.now(),
	})
	expect(discoveredFiles).toEqual([...files].sort((a, b) => a.localeCompare(b)))
	expect(limited).toBe(false)
	if (!includeDirectories) {
		expect(readdir.mock.calls.length).toBe(0)
		expect(Date.now()).toBe(20)
	}
})
