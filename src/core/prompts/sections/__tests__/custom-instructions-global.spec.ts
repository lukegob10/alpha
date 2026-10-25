import * as path from "path"

// Use vi.hoisted to ensure mocks are available during hoisting
const {
	mockHomedir,
	mockStat,
	mockReadFile,
	mockReaddir,
	mockLstat,
	mockRealpath,
	mockGetLegacyConfigDirectoriesForCwd,
	mockGetAllLegacyConfigDirectoriesForCwd,
	mockGetAgentsDirectoriesForCwd,
	mockGetProjectInstructionDirectoriesForCwd,
	mockGetLegacyGlobalConfigDirectory,
} = vi.hoisted(() => ({
	mockHomedir: vi.fn(),
	mockStat: vi.fn(),
	mockReadFile: vi.fn(),
	mockReaddir: vi.fn(),
	mockLstat: vi.fn(),
	mockRealpath: vi.fn(),
	mockGetLegacyConfigDirectoriesForCwd: vi.fn(),
	mockGetAllLegacyConfigDirectoriesForCwd: vi.fn(),
	mockGetAgentsDirectoriesForCwd: vi.fn(),
	mockGetProjectInstructionDirectoriesForCwd: vi.fn(),
	mockGetLegacyGlobalConfigDirectory: vi.fn(),
}))

// Mock os module
vi.mock("os", () => ({
	default: {
		homedir: mockHomedir,
	},
	homedir: mockHomedir,
}))

// Mock fs/promises
vi.mock("fs/promises", () => ({
	default: {
		stat: mockStat,
		readFile: mockReadFile,
		readdir: mockReaddir,
		lstat: mockLstat,
		realpath: mockRealpath,
	},
}))

// Mock the roo-config service
vi.mock("../../../../services/config-paths", () => ({
	getLegacyConfigDirectoriesForCwd: mockGetLegacyConfigDirectoriesForCwd,
	getAllLegacyConfigDirectoriesForCwd: mockGetAllLegacyConfigDirectoriesForCwd,
	getAgentsDirectoriesForCwd: mockGetAgentsDirectoriesForCwd,
	getProjectInstructionDirectoriesForCwd: mockGetProjectInstructionDirectoriesForCwd,
	getLegacyGlobalConfigDirectory: mockGetLegacyGlobalConfigDirectory,
}))

import { loadRuleFiles, addCustomInstructions } from "../custom-instructions"

describe("custom-instructions global .roo support", () => {
	const mockCwd = "/mock/project"
	const mockHomeDir = "/mock/home"
	const legacyGlobalConfigDir = path.join(mockHomeDir, ".roo")
	const legacyProjectConfigDir = path.join(mockCwd, ".roo")

	beforeEach(() => {
		vi.resetAllMocks()
		mockHomedir.mockReturnValue(mockHomeDir)
		mockGetLegacyConfigDirectoriesForCwd.mockReturnValue([legacyGlobalConfigDir, legacyProjectConfigDir])
		// getAllLegacyConfigDirectoriesForCwd is now async and returns the same directories by default
		mockGetAllLegacyConfigDirectoriesForCwd.mockResolvedValue([legacyGlobalConfigDir, legacyProjectConfigDir])
		// getAgentsDirectoriesForCwd returns parent directories (without .roo)
		mockGetAgentsDirectoriesForCwd.mockResolvedValue([mockCwd])
		mockGetProjectInstructionDirectoriesForCwd.mockResolvedValue({ root: mockCwd, directories: [mockCwd] })
		mockGetLegacyGlobalConfigDirectory.mockReturnValue(legacyGlobalConfigDir)
		// Default lstat to reject (file not found)
		mockLstat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
		mockStat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
		mockReaddir.mockResolvedValue([])
		mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
		mockRealpath.mockImplementation(async (filePath) => filePath.toString())
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("loadRuleFiles", () => {
		it("should load global rules only when project rules do not exist", async () => {
			// Mock directory existence checks in order:
			// 1. Check if global rules dir exists
			// 2. Check if project rules dir doesn't exist
			mockStat
				.mockResolvedValueOnce({ isDirectory: () => true } as any) // global rules dir exists
				.mockResolvedValueOnce({ isFile: () => true } as any) // for the file check inside readTextFilesFromDirectory
				.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) // project rules dir doesn't exist

			// Mock directory reading for global rules
			mockReaddir.mockResolvedValueOnce([
				{
					name: "rules.md",
					isFile: () => true,
					isSymbolicLink: () => false,
				} as any,
			])

			// Mock file reading for the rules.md file
			mockReadFile.mockResolvedValueOnce("global rule content")

			const result = await loadRuleFiles(mockCwd)

			expect(result).toContain("# Rules from")
			expect(result).toContain("rules.md:")
			expect(result).toContain("global rule content")
			expect(result).not.toContain("project rule content")
		})

		it("should load project rules only when global rules do not exist", async () => {
			// Mock directory existence
			mockStat
				.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) // global rules dir doesn't exist
				.mockResolvedValueOnce({ isDirectory: () => true } as any) // project rules dir exists

			// Mock directory reading for project rules
			mockReaddir.mockResolvedValueOnce([
				{
					name: "rules.md",
					isFile: () => true,
					isSymbolicLink: () => false,
				} as any,
			])

			// Mock file reading
			mockStat.mockResolvedValueOnce({ isFile: () => true } as any) // for the file check
			mockReadFile.mockResolvedValueOnce("project rule content")

			const result = await loadRuleFiles(mockCwd)

			expect(result).toContain("# Rules from")
			expect(result).toContain("rules.md:")
			expect(result).toContain("project rule content")
			expect(result).not.toContain("global rule content")
		})

		it("should merge global and project rules with project rules after global", async () => {
			// Mock directory existence - both exist
			mockStat
				.mockResolvedValueOnce({ isDirectory: () => true } as any) // global rules dir exists
				.mockResolvedValueOnce({ isFile: () => true } as any) // global file check
				.mockResolvedValueOnce({ isDirectory: () => true } as any) // project rules dir exists
				.mockResolvedValueOnce({ isFile: () => true } as any) // project file check

			// Mock directory reading
			mockReaddir
				.mockResolvedValueOnce([
					{
						name: "global.md",
						isFile: () => true,
						isSymbolicLink: () => false,
					} as any,
				])
				.mockResolvedValueOnce([
					{
						name: "project.md",
						isFile: () => true,
						isSymbolicLink: () => false,
					} as any,
				])

			// Mock file reading
			mockReadFile.mockResolvedValueOnce("global rule content").mockResolvedValueOnce("project rule content")

			const result = await loadRuleFiles(mockCwd)

			expect(result).toContain("# Rules from")
			expect(result).toContain("global.md:")
			expect(result).toContain("global rule content")
			expect(result).toContain("project.md:")
			expect(result).toContain("project rule content")

			// Ensure project rules come after global rules
			const globalIndex = result.indexOf("global rule content")
			const projectIndex = result.indexOf("project rule content")
			expect(globalIndex).toBeLessThan(projectIndex)
		})

		it("should fall back to legacy .alpharules file when no .alpha/rules directories exist", async () => {
			// Mock directory existence - neither exist
			mockStat
				.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) // global rules dir doesn't exist
				.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) // project rules dir doesn't exist

			// Mock legacy file reading
			mockReadFile.mockResolvedValueOnce("legacy rule content")

			const result = await loadRuleFiles(mockCwd)

			expect(result).toContain("# Rules from .alpharules:")
			expect(result).toContain("legacy rule content")
		})

		it("should return empty string when no rules exist anywhere", async () => {
			// Mock directory existence - neither exist
			mockStat
				.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) // global rules dir doesn't exist
				.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) // project rules dir doesn't exist

			// Mock legacy file reading - both fail (using safeReadFile which catches errors)
			// The safeReadFile function catches ENOENT errors and returns empty string
			// So we don't need to mock rejections, just empty responses
			mockReadFile
				.mockResolvedValueOnce("") // .alpharules returns empty (simulating ENOENT caught by safeReadFile)
				.mockResolvedValueOnce("") // .alpharules returns empty (simulating ENOENT caught by safeReadFile)

			const result = await loadRuleFiles(mockCwd)

			expect(result).toBe("")
		})
	})

	describe("addCustomInstructions mode-specific rules", () => {
		it("should load global and project mode-specific rules", async () => {
			const mode = "code"
			const globalDirectory = path.resolve(mockHomeDir, ".alpha", "rules-code")
			const projectDirectory = path.resolve(mockCwd, ".alpha", "rules-code")
			const modeFiles = new Map([
				[path.join(globalDirectory, "global-mode.md"), "global mode rule content"],
				[path.join(projectDirectory, "project-mode.md"), "project mode rule content"],
			])
			// Source reads can overlap; fixture metadata belongs to a path, not a call position.
			mockStat.mockImplementation(async (filename: string) => {
				const resolved = path.resolve(filename)
				const isDirectory = resolved === globalDirectory || resolved === projectDirectory
				const isFile = modeFiles.has(resolved)
				if (!isDirectory && !isFile) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
				return { isDirectory: () => isDirectory, isFile: () => isFile }
			})
			mockReaddir.mockImplementation(async (directory: string) =>
				[...modeFiles.keys()]
					.filter((filename) => path.dirname(filename) === path.resolve(directory))
					.map((filename) => ({
						name: path.basename(filename),
						isFile: () => true,
						isSymbolicLink: () => false,
					})),
			)
			mockReadFile.mockImplementation(async (filename: string) => modeFiles.get(filename) ?? "")

			const result = await addCustomInstructions("", "", mockCwd, mode)

			expect(result).toContain("# Rules from")
			expect(result).toContain("global-mode.md:")
			expect(result).toContain("global mode rule content")
			expect(result).toContain("project-mode.md:")
			expect(result).toContain("project mode rule content")
		})

		it("should fall back to legacy mode-specific files when no mode directories exist", async () => {
			const mode = "code"
			mockStat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))
			mockReadFile.mockImplementation(async (filename: string) =>
				filename === path.join(mockCwd, ".alpharules-code") ? "legacy mode rule content" : "",
			)

			const result = await addCustomInstructions("", "", mockCwd, mode)

			expect(result).toContain("# Rules from .alpharules-code:")
			expect(result).toContain("legacy mode rule content")
		})
	})
})
