import path from "path"

const { stat, lstat, realpath, readdir, readFile, fixtureHome } = vi.hoisted(() => ({
	stat: vi.fn(),
	lstat: vi.fn(),
	realpath: vi.fn(),
	readdir: vi.fn(),
	readFile: vi.fn(),
	fixtureHome: { value: "" },
}))

vi.mock("fs/promises", () => {
	const methods = { stat, lstat, realpath, readdir, readFile }
	return { ...methods, default: methods }
})
vi.mock("os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("os")>()
	return { ...actual, homedir: () => fixtureHome.value, default: { ...actual, homedir: () => fixtureHome.value } }
})

import { addCustomInstructionParts, renderCustomInstructionParts } from "../custom-instructions"

describe("custom instruction preparation latency", () => {
	const cwd = path.resolve("/instruction-performance/workspace")
	const home = path.resolve("/instruction-performance/home")
	const files = new Map<string, string>()
	const directories = new Set<string>()
	let activeOperations = 0
	let peakOperations = 0

	const missing = () => Object.assign(new Error("Fixture path does not exist"), { code: "ENOENT" })
	const pause = async () => {
		activeOperations++
		peakOperations = Math.max(peakOperations, activeOperations)
		await new Promise((resolve) => setTimeout(resolve, 10))
		activeOperations--
	}
	const write = (relativePath: string, text: string) => {
		const filename = path.join(cwd, relativePath)
		files.set(filename, text)
		let directory = path.dirname(filename)
		while (directory !== cwd && directory !== path.dirname(directory)) {
			directories.add(directory)
			directory = path.dirname(directory)
		}
	}
	const assemble = () => addCustomInstructionParts("Mode guidance", "Global guidance", cwd, "code")

	beforeEach(() => {
		vi.resetAllMocks()
		vi.useFakeTimers()
		vi.setSystemTime(0)
		fixtureHome.value = home
		files.clear()
		directories.clear()
		activeOperations = 0
		peakOperations = 0
		for (const directory of [cwd, home, path.join(cwd, ".git")]) directories.add(directory)
		write("AGENTS.md", "Project agent guidance")
		write(".alpha/rules-code/mode.md", "Project mode guidance")
		write(".alpha/rules/project.md", "Project generic guidance")

		const metadata = async (filename: string) => {
			await pause()
			const isDirectory = directories.has(filename)
			const isFile = files.has(filename)
			if (!isDirectory && !isFile) throw missing()
			return { isDirectory: () => isDirectory, isFile: () => isFile, isSymbolicLink: () => false }
		}
		stat.mockImplementation(metadata)
		lstat.mockImplementation(metadata)
		realpath.mockImplementation(async (filename: string) => {
			await pause()
			if (!directories.has(filename) && !files.has(filename)) throw missing()
			return filename
		})
		readdir.mockImplementation(async (directory: string) => {
			await pause()
			return [...files.keys()]
				.filter((filename) => path.dirname(filename) === directory)
				.map((filename) => ({
					name: path.basename(filename),
					parentPath: directory,
					isFile: () => true,
					isSymbolicLink: () => false,
				}))
		})
		readFile.mockImplementation(async (filename: string) => {
			await pause()
			const text = files.get(filename)
			if (text === undefined) throw missing()
			return text
		})
	})

	afterEach(() => vi.useRealTimers())

	it("prepares independent rule sources without adding their I/O latencies", async () => {
		const pending = assemble()
		await vi.runAllTimersAsync()
		const parts = await pending
		const elapsedMs = Date.now()
		const ioCalls = [stat, lstat, realpath, readdir, readFile].reduce(
			(count, mock) => count + mock.mock.calls.length,
			0,
		)
		console.info("INSTRUCTION_ASSEMBLY_BENCHMARK", { elapsedMs, ioCalls, peakOperations })

		expect(parts.filter(({ origin }) => ["mode-rules", "agent-rules", "generic-rules"].includes(origin))).toEqual([
			{
				role: "user",
				origin: "mode-rules",
				content: `# Rules from rules-code directories:\n\n# Rules from ${path.join(".alpha", "rules-code", "mode.md")}:\nProject mode guidance`,
			},
			{
				role: "user",
				origin: "agent-rules",
				content: "# Agent Rules Standard (AGENTS.md):\nProject agent guidance",
			},
			{
				role: "user",
				origin: "generic-rules",
				content: `# Rules from .alpha directories:\n\n# Rules from ${path.join(".alpha", "rules", "project.md")}:\nProject generic guidance`,
			},
		])
		expect(elapsedMs).toBe(70)
		expect(ioCalls).toBe(21)
		expect(peakOperations).toBeLessThanOrEqual(6)
		expect(activeOperations).toBe(0)
	})

	it("reads fresh sources and keeps Alpha and AGENTS override precedence on each preparation", async () => {
		write(".roo/rules-code/legacy.md", "Legacy mode guidance")
		write(".roo/rules/legacy.md", "Legacy generic guidance")
		write("AGENTS.override.md", "Preferred agent guidance")
		const firstPending = assemble()
		await vi.runAllTimersAsync()
		const first = renderCustomInstructionParts(await firstPending)
		expect(first).toContain("Preferred agent guidance")
		expect(first).not.toContain("Project agent guidance")
		expect(first).not.toContain("Legacy mode guidance")
		expect(first).not.toContain("Legacy generic guidance")

		write("AGENTS.override.md", "Updated preferred agent guidance")
		write(".alpha/rules-code/mode.md", "Updated mode guidance")
		write(".alpha/rules/project.md", "Updated generic guidance")
		const nextPending = assemble()
		await vi.runAllTimersAsync()
		const next = renderCustomInstructionParts(await nextPending)
		expect(next).toContain("Updated preferred agent guidance")
		expect(next).toContain("Updated mode guidance")
		expect(next).toContain("Updated generic guidance")
		expect(next).not.toContain("Project mode guidance")
		expect(next).not.toContain("Project generic guidance")
		expect(activeOperations).toBe(0)
	})

	it("does not read agent files when agent rules are disabled", async () => {
		const pending = addCustomInstructionParts("", "", cwd, "code", {
			settings: { useAgentRules: false, todoListEnabled: true, newTaskRequireTodos: false },
		})
		await vi.runAllTimersAsync()
		const parts = await pending
		expect(parts.some(({ origin }) => origin === "agent-rules")).toBe(false)
		expect(lstat).not.toHaveBeenCalled()
		expect(readFile.mock.calls.some(([filename]) => path.basename(filename).startsWith("AGENT"))).toBe(false)
	})

	it("keeps mode-read failures authoritative when a generic fallback fails sooner", async () => {
		files.clear()
		directories.clear()
		for (const directory of [cwd, home, path.join(cwd, ".git")]) directories.add(directory)
		write(".alpharules-code", "Unreadable mode fallback")
		write(".alpharules", "Unreadable generic fallback")
		const modeError = Object.assign(new Error("Mode fallback access denied"), { code: "EPERM" })
		const genericError = Object.assign(new Error("Generic fallback access denied"), { code: "EPERM" })
		readFile.mockImplementation(async (filename: string) => {
			await pause()
			if (filename === path.join(cwd, ".alpharules-code")) {
				await pause()
				throw modeError
			}
			if (filename === path.join(cwd, ".alpharules")) throw genericError
			throw missing()
		})
		const pending = assemble().then(
			() => undefined,
			(error: unknown) => error,
		)
		await vi.runAllTimersAsync()
		expect(await pending).toBe(modeError)
		expect(readFile).toHaveBeenCalledWith(path.join(cwd, ".alpharules"), "utf-8")
		expect(activeOperations).toBe(0)
	})
})
