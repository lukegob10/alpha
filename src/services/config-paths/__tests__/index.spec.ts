import * as path from "path"

// Use vi.hoisted to ensure mocks are available during hoisting
const { mockStat, mockReadFile, mockHomedir, mockExecuteRipgrep } = vi.hoisted(() => ({
	mockStat: vi.fn(),
	mockReadFile: vi.fn(),
	mockHomedir: vi.fn(),
	mockExecuteRipgrep: vi.fn(),
}))

// Mock fs/promises module
vi.mock("fs/promises", () => ({
	default: {
		stat: mockStat,
		readFile: mockReadFile,
	},
	stat: mockStat,
	readFile: mockReadFile,
}))

// Mock os module
vi.mock("os", () => ({
	homedir: mockHomedir,
}))

// Mock executeRipgrep from search service
vi.mock("../../search/file-search", () => ({
	executeRipgrep: mockExecuteRipgrep,
}))

import {
	getGlobalConfigDirectory,
	getGlobalAgentsDirectory,
	getProjectConfigDirectory,
	getProjectAgentsDirectoryForCwd,
	directoryExists,
	fileExists,
	readFileIfExists,
	getConfigDirectoriesForCwd,
	getAllConfigDirectoriesForCwd,
	getAgentsDirectoriesForCwd,
	discoverSubfolderConfigDirectories,
	loadConfiguration,
} from "../index"

describe("AlphaConfigService", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockHomedir.mockReturnValue("/mock/home")
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("getGlobalConfigDirectory", () => {
		it("should return correct path for global .alpha directory", () => {
			const result = getGlobalConfigDirectory()
			expect(result).toBe(path.join("/mock/home", ".alpha"))
		})

		it("should handle different home directories", () => {
			mockHomedir.mockReturnValue("/different/home")
			const result = getGlobalConfigDirectory()
			expect(result).toBe(path.join("/different/home", ".alpha"))
		})
	})

	describe("getProjectConfigDirectory", () => {
		it("should return correct path for given cwd", () => {
			const cwd = "/custom/project/path"
			const result = getProjectConfigDirectory(cwd)
			expect(result).toBe(path.join(cwd, ".alpha"))
		})
	})

	describe("getGlobalAgentsDirectory", () => {
		it("should return correct path for global .agents directory", () => {
			const result = getGlobalAgentsDirectory()
			expect(result).toBe(path.join("/mock/home", ".agents"))
		})

		it("should handle different home directories", () => {
			mockHomedir.mockReturnValue("/different/home")
			const result = getGlobalAgentsDirectory()
			expect(result).toBe(path.join("/different/home", ".agents"))
		})
	})

	describe("getProjectAgentsDirectoryForCwd", () => {
		it("should return correct path for given cwd", () => {
			const cwd = "/custom/project/path"
			const result = getProjectAgentsDirectoryForCwd(cwd)
			expect(result).toBe(path.join(cwd, ".agents"))
		})
	})

	describe("directoryExists", () => {
		it("should return true for existing directory", async () => {
			mockStat.mockResolvedValue({ isDirectory: () => true } as any)

			const result = await directoryExists("/some/path")

			expect(result).toBe(true)
			expect(mockStat).toHaveBeenCalledWith("/some/path")
		})

		it("should return false for non-existing path", async () => {
			const error = new Error("ENOENT") as any
			error.code = "ENOENT"
			mockStat.mockRejectedValue(error)

			const result = await directoryExists("/non/existing/path")

			expect(result).toBe(false)
		})

		it("should return false for ENOTDIR error", async () => {
			const error = new Error("ENOTDIR") as any
			error.code = "ENOTDIR"
			mockStat.mockRejectedValue(error)

			const result = await directoryExists("/not/a/directory")

			expect(result).toBe(false)
		})

		it("should throw unexpected errors", async () => {
			const error = new Error("Permission denied") as any
			error.code = "EACCES"
			mockStat.mockRejectedValue(error)

			await expect(directoryExists("/permission/denied")).rejects.toThrow("Permission denied")
		})

		it("should return false for files", async () => {
			mockStat.mockResolvedValue({ isDirectory: () => false } as any)

			const result = await directoryExists("/some/file.txt")

			expect(result).toBe(false)
		})
	})

	describe("fileExists", () => {
		it("should return true for existing file", async () => {
			mockStat.mockResolvedValue({ isFile: () => true } as any)

			const result = await fileExists("/some/file.txt")

			expect(result).toBe(true)
			expect(mockStat).toHaveBeenCalledWith("/some/file.txt")
		})

		it("should return false for non-existing file", async () => {
			const error = new Error("ENOENT") as any
			error.code = "ENOENT"
			mockStat.mockRejectedValue(error)

			const result = await fileExists("/non/existing/file.txt")

			expect(result).toBe(false)
		})

		it("should return false for ENOTDIR error", async () => {
			const error = new Error("ENOTDIR") as any
			error.code = "ENOTDIR"
			mockStat.mockRejectedValue(error)

			const result = await fileExists("/not/a/directory/file.txt")

			expect(result).toBe(false)
		})

		it("should throw unexpected errors", async () => {
			const error = new Error("Permission denied") as any
			error.code = "EACCES"
			mockStat.mockRejectedValue(error)

			await expect(fileExists("/permission/denied/file.txt")).rejects.toThrow("Permission denied")
		})

		it("should return false for directories", async () => {
			mockStat.mockResolvedValue({ isFile: () => false } as any)

			const result = await fileExists("/some/directory")

			expect(result).toBe(false)
		})
	})

	describe("readFileIfExists", () => {
		it("should return file content for existing file", async () => {
			mockReadFile.mockResolvedValue("file content")

			const result = await readFileIfExists("/some/file.txt")

			expect(result).toBe("file content")
			expect(mockReadFile).toHaveBeenCalledWith("/some/file.txt", "utf-8")
		})

		it("should return null for non-existing file", async () => {
			const error = new Error("ENOENT") as any
			error.code = "ENOENT"
			mockReadFile.mockRejectedValue(error)

			const result = await readFileIfExists("/non/existing/file.txt")

			expect(result).toBe(null)
		})

		it("should return null for ENOTDIR error", async () => {
			const error = new Error("ENOTDIR") as any
			error.code = "ENOTDIR"
			mockReadFile.mockRejectedValue(error)

			const result = await readFileIfExists("/not/a/directory/file.txt")

			expect(result).toBe(null)
		})

		it("should return null for EISDIR error", async () => {
			const error = new Error("EISDIR") as any
			error.code = "EISDIR"
			mockReadFile.mockRejectedValue(error)

			const result = await readFileIfExists("/is/a/directory")

			expect(result).toBe(null)
		})

		it("should throw unexpected errors", async () => {
			const error = new Error("Permission denied") as any
			error.code = "EACCES"
			mockReadFile.mockRejectedValue(error)

			await expect(readFileIfExists("/permission/denied/file.txt")).rejects.toThrow("Permission denied")
		})
	})

	describe("getConfigDirectoriesForCwd", () => {
		it("should return directories for given cwd", () => {
			const cwd = "/custom/project/path"

			const result = getConfigDirectoriesForCwd(cwd)

			expect(result).toEqual([path.join("/mock/home", ".alpha"), path.join(cwd, ".alpha")])
		})
	})

	describe("loadConfiguration", () => {
		it("should load global configuration only when project does not exist", async () => {
			const error = new Error("ENOENT") as any
			error.code = "ENOENT"
			mockReadFile.mockResolvedValueOnce("global content").mockRejectedValueOnce(error)

			const result = await loadConfiguration("rules/rules.md", "/project/path")

			expect(result).toEqual({
				global: "global content",
				project: null,
				merged: "global content",
			})
		})

		it("should load project configuration only when global does not exist", async () => {
			const error = new Error("ENOENT") as any
			error.code = "ENOENT"
			mockReadFile.mockRejectedValueOnce(error).mockResolvedValueOnce("project content")

			const result = await loadConfiguration("rules/rules.md", "/project/path")

			expect(result).toEqual({
				global: null,
				project: "project content",
				merged: "project content",
			})
		})

		it("should merge global and project configurations with project overriding global", async () => {
			mockReadFile.mockResolvedValueOnce("global content").mockResolvedValueOnce("project content")

			const result = await loadConfiguration("rules/rules.md", "/project/path")

			expect(result).toEqual({
				global: "global content",
				project: "project content",
				merged: "global content\n\n# Project-specific rules (override global):\n\nproject content",
			})
		})

		it("should return empty merged content when neither exists", async () => {
			const error = new Error("ENOENT") as any
			error.code = "ENOENT"
			mockReadFile.mockRejectedValueOnce(error).mockRejectedValueOnce(error)

			const result = await loadConfiguration("rules/rules.md", "/project/path")

			expect(result).toEqual({
				global: null,
				project: null,
				merged: "",
			})
		})

		it("should propagate unexpected errors from global file read", async () => {
			const error = new Error("Permission denied") as any
			error.code = "EACCES"
			mockReadFile.mockRejectedValueOnce(error)

			await expect(loadConfiguration("rules/rules.md", "/project/path")).rejects.toThrow("Permission denied")
		})

		it("should propagate unexpected errors from project file read", async () => {
			const globalError = new Error("ENOENT") as any
			globalError.code = "ENOENT"
			const projectError = new Error("Permission denied") as any
			projectError.code = "EACCES"

			mockReadFile.mockRejectedValueOnce(globalError).mockRejectedValueOnce(projectError)

			await expect(loadConfiguration("rules/rules.md", "/project/path")).rejects.toThrow("Permission denied")
		})

		it("should use correct file paths", async () => {
			mockReadFile.mockResolvedValue("content")

			await loadConfiguration("rules/rules.md", "/project/path")

			expect(mockReadFile).toHaveBeenCalledWith(path.join("/mock/home", ".alpha", "rules/rules.md"), "utf-8")
			expect(mockReadFile).toHaveBeenCalledWith(path.join("/project/path", ".alpha", "rules/rules.md"), "utf-8")
		})
	})

	describe("discoverSubfolderConfigDirectories", () => {
		it("should return empty array when no subfolder .alpha directories found", async () => {
			mockExecuteRipgrep.mockResolvedValue([])

			const result = await discoverSubfolderConfigDirectories("/project/path")

			expect(result).toEqual([])
		})

		it("should discover .alpha directories from subfolders", async () => {
			// Find any file inside .alpha directories
			mockExecuteRipgrep.mockResolvedValueOnce([
				{ path: "package-a/.alpha/rules/rule.md", type: "file" },
				{ path: "package-b/.alpha/rules-code/rule.md", type: "file" },
			])

			const result = await discoverSubfolderConfigDirectories("/project/path")

			expect(result).toEqual([
				path.join("/project/path", "package-a", ".alpha"),
				path.join("/project/path", "package-b", ".alpha"),
			])
		})

		it("should sort discovered directories alphabetically", async () => {
			mockExecuteRipgrep.mockResolvedValueOnce([
				{ path: "zebra/.alpha/rules/rule.md", type: "file" },
				{ path: "apple/.alpha/rules/rule.md", type: "file" },
				{ path: "mango/.alpha/rules/rule.md", type: "file" },
			])

			const result = await discoverSubfolderConfigDirectories("/project/path")

			expect(result).toEqual([
				path.join("/project/path", "apple", ".alpha"),
				path.join("/project/path", "mango", ".alpha"),
				path.join("/project/path", "zebra", ".alpha"),
			])
		})

		it("should exclude root .alpha directory", async () => {
			// This would match the root .alpha, which should be excluded
			mockExecuteRipgrep.mockResolvedValueOnce([
				{ path: ".alpha/rules/rule.md", type: "file" }, // This is root - should be excluded
				{ path: "subfolder/.alpha/rules/rule.md", type: "file" },
			])

			const result = await discoverSubfolderConfigDirectories("/project/path")

			// Should only include subfolder, not root
			expect(result).toEqual([path.join("/project/path", "subfolder", ".alpha")])
		})

		it("should handle nested subdirectories", async () => {
			mockExecuteRipgrep.mockResolvedValueOnce([
				{ path: "packages/core/.alpha/rules/rule.md", type: "file" },
				{ path: "packages/utils/.alpha/rules-code/rule.md", type: "file" },
			])

			const result = await discoverSubfolderConfigDirectories("/project/path")

			expect(result).toEqual([
				path.join("/project/path", "packages/core", ".alpha"),
				path.join("/project/path", "packages/utils", ".alpha"),
			])
		})

		it("should return empty array on ripgrep error", async () => {
			mockExecuteRipgrep.mockRejectedValue(new Error("ripgrep failed"))

			const result = await discoverSubfolderConfigDirectories("/project/path")

			expect(result).toEqual([])
		})

		it("should deduplicate .alpha directories from multiple files", async () => {
			mockExecuteRipgrep.mockResolvedValueOnce([
				{ path: "package-a/.alpha/rules/rule1.md", type: "file" },
				{ path: "package-a/.alpha/rules/rule2.md", type: "file" },
				{ path: "package-a/.alpha/rules-code/rule3.md", type: "file" },
			])

			const result = await discoverSubfolderConfigDirectories("/project/path")

			// Should only include package-a/.alpha once
			expect(result).toEqual([path.join("/project/path", "package-a", ".alpha")])
		})

		it("should discover .alpha directories with any content", async () => {
			// Should find .alpha directories regardless of what's inside them
			mockExecuteRipgrep.mockResolvedValueOnce([
				{ path: "package-a/.alpha/rules/rule.md", type: "file" },
				{ path: "package-b/.alpha/rules-code/code-rule.md", type: "file" },
				{ path: "package-c/.alpha/rules-architect/arch-rule.md", type: "file" },
				{ path: "package-d/.alpha/config/settings.json", type: "file" },
			])

			const result = await discoverSubfolderConfigDirectories("/project/path")

			expect(result).toEqual([
				path.join("/project/path", "package-a", ".alpha"),
				path.join("/project/path", "package-b", ".alpha"),
				path.join("/project/path", "package-c", ".alpha"),
				path.join("/project/path", "package-d", ".alpha"),
			])
		})
	})

	describe("getAllConfigDirectoriesForCwd", () => {
		it("should return global, project, and subfolder directories", async () => {
			mockExecuteRipgrep.mockResolvedValueOnce([{ path: "subfolder/.alpha/rules/rule.md", type: "file" }])

			const result = await getAllConfigDirectoriesForCwd("/project/path")

			expect(result).toEqual([
				path.join("/mock/home", ".alpha"), // global
				path.join("/project/path", ".alpha"), // project
				path.join("/project/path", "subfolder", ".alpha"), // subfolder
			])
		})

		it("should return only global and project when no subfolders", async () => {
			mockExecuteRipgrep.mockResolvedValue([])

			const result = await getAllConfigDirectoriesForCwd("/project/path")

			expect(result).toEqual([path.join("/mock/home", ".alpha"), path.join("/project/path", ".alpha")])
		})

		it("should maintain order: global, project, subfolders (alphabetically)", async () => {
			mockExecuteRipgrep.mockResolvedValueOnce([
				{ path: "zebra/.alpha/rules/rule.md", type: "file" },
				{ path: "apple/.alpha/rules/rule.md", type: "file" },
			])

			const result = await getAllConfigDirectoriesForCwd("/project/path")

			expect(result).toEqual([
				path.join("/mock/home", ".alpha"), // global first
				path.join("/project/path", ".alpha"), // project second
				path.join("/project/path", "apple", ".alpha"), // subfolders alphabetically
				path.join("/project/path", "zebra", ".alpha"),
			])
		})
	})

	describe("getAgentsDirectoriesForCwd", () => {
		it("should return root directory and parent directories of subfolder .alpha dirs", async () => {
			mockExecuteRipgrep.mockResolvedValueOnce([{ path: "package-a/.alpha/rules/rule.md", type: "file" }])

			const result = await getAgentsDirectoriesForCwd("/project/path")

			expect(result).toEqual([
				"/project/path", // root
				path.join("/project/path", "package-a"), // parent of .alpha
			])
		})

		it("should always include root even when no subfolders", async () => {
			mockExecuteRipgrep.mockResolvedValue([])

			const result = await getAgentsDirectoriesForCwd("/project/path")

			expect(result).toEqual(["/project/path"])
		})

		it("should include multiple subfolder parent directories", async () => {
			mockExecuteRipgrep.mockResolvedValueOnce([
				{ path: "package-a/.alpha/rules/rule.md", type: "file" },
				{ path: "package-b/.alpha/rules-code/rule.md", type: "file" },
				{ path: "packages/core/.alpha/rules/rule.md", type: "file" },
			])

			const result = await getAgentsDirectoriesForCwd("/project/path")

			expect(result).toEqual([
				"/project/path",
				path.join("/project/path", "package-a"),
				path.join("/project/path", "package-b"),
				path.join("/project/path", "packages/core"),
			])
		})
	})
})
