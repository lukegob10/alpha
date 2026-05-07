import path from "path"
import { RooProtectedController } from "../RooProtectedController"

describe("RooProtectedController", () => {
	const TEST_CWD = "/test/workspace"
	let controller: RooProtectedController

	beforeEach(() => {
		controller = new RooProtectedController(TEST_CWD)
	})

	describe("isWriteProtected", () => {
		it("should protect .alphaignore file", () => {
			expect(controller.isWriteProtected(".alphaignore")).toBe(true)
		})

		it("should protect files in .roo directory", () => {
			expect(controller.isWriteProtected(".alpha/config.json")).toBe(true)
			expect(controller.isWriteProtected(".alpha/settings/user.json")).toBe(true)
			expect(controller.isWriteProtected(".alpha/modes/custom.json")).toBe(true)
		})

		it("should protect .rooprotected file", () => {
			expect(controller.isWriteProtected(".rooprotected")).toBe(true)
		})

		it("should protect .alphamodes files", () => {
			expect(controller.isWriteProtected(".alphamodes")).toBe(true)
		})

		it("should protect .alpharules* files", () => {
			expect(controller.isWriteProtected(".alpharules")).toBe(true)
			expect(controller.isWriteProtected(".alpharules.md")).toBe(true)
		})

		it("should protect .alpharules* files", () => {
			expect(controller.isWriteProtected(".alpharules")).toBe(true)
			expect(controller.isWriteProtected(".alpharules.md")).toBe(true)
		})

		it("should protect files in .vscode directory", () => {
			expect(controller.isWriteProtected(".vscode/settings.json")).toBe(true)
			expect(controller.isWriteProtected(".vscode/launch.json")).toBe(true)
			expect(controller.isWriteProtected(".vscode/tasks.json")).toBe(true)
		})

		it("should protect .code-workspace files", () => {
			expect(controller.isWriteProtected("myproject.code-workspace")).toBe(true)
			expect(controller.isWriteProtected("pentest.code-workspace")).toBe(true)
			expect(controller.isWriteProtected(".code-workspace")).toBe(true)
			expect(controller.isWriteProtected("folder/workspace.code-workspace")).toBe(true)
		})

		it("should protect AGENTS.md file", () => {
			expect(controller.isWriteProtected("AGENTS.md")).toBe(true)
		})

		it("should protect AGENT.md file", () => {
			expect(controller.isWriteProtected("AGENT.md")).toBe(true)
		})

		it("should not protect other files starting with .roo", () => {
			expect(controller.isWriteProtected(".roosettings")).toBe(false)
			expect(controller.isWriteProtected(".rooconfig")).toBe(false)
		})

		it("should not protect regular files", () => {
			expect(controller.isWriteProtected("src/index.ts")).toBe(false)
			expect(controller.isWriteProtected("package.json")).toBe(false)
			expect(controller.isWriteProtected("README.md")).toBe(false)
		})

		it("should not protect files that contain 'roo' but don't start with .roo", () => {
			expect(controller.isWriteProtected("src/roo-utils.ts")).toBe(false)
			expect(controller.isWriteProtected("config/roo.config.js")).toBe(false)
		})

		it("should handle nested paths correctly", () => {
			expect(controller.isWriteProtected(".alpha/config.json")).toBe(true) // .alpha/** matches at root
			expect(controller.isWriteProtected("nested/.alphaignore")).toBe(true) // .alphaignore matches anywhere by default
			expect(controller.isWriteProtected("nested/.alphamodes")).toBe(true) // .alphamodes matches anywhere by default
			expect(controller.isWriteProtected("nested/.alpharules.md")).toBe(true) // .alpharules* matches anywhere by default
		})

		it("should handle absolute paths by converting to relative", () => {
			const absolutePath = path.join(TEST_CWD, ".alphaignore")
			expect(controller.isWriteProtected(absolutePath)).toBe(true)
		})

		it("should handle paths with different separators", () => {
			expect(controller.isWriteProtected(".roo\\config.json")).toBe(true)
			expect(controller.isWriteProtected(".alpha/config.json")).toBe(true)
		})

		it("should not throw for absolute paths outside cwd", () => {
			expect(controller.isWriteProtected("/tmp/comment-2-pr63.json")).toBe(false)
			expect(controller.isWriteProtected("/etc/passwd")).toBe(false)
		})
	})

	describe("getProtectedFiles", () => {
		it("should return set of protected files from a list", () => {
			const files = ["src/index.ts", ".alphaignore", "package.json", ".alpha/config.json", "README.md"]

			const protectedFiles = controller.getProtectedFiles(files)

			expect(protectedFiles).toEqual(new Set([".alphaignore", ".alpha/config.json"]))
		})

		it("should return empty set when no files are protected", () => {
			const files = ["src/index.ts", "package.json", "README.md"]

			const protectedFiles = controller.getProtectedFiles(files)

			expect(protectedFiles).toEqual(new Set())
		})
	})

	describe("annotatePathsWithProtection", () => {
		it("should annotate paths with protection status", () => {
			const files = ["src/index.ts", ".alphaignore", ".alpha/config.json", "package.json"]

			const annotated = controller.annotatePathsWithProtection(files)

			expect(annotated).toEqual([
				{ path: "src/index.ts", isProtected: false },
				{ path: ".alphaignore", isProtected: true },
				{ path: ".alpha/config.json", isProtected: true },
				{ path: "package.json", isProtected: false },
			])
		})
	})

	describe("getProtectionMessage", () => {
		it("should return appropriate protection message", () => {
			const message = controller.getProtectionMessage()
			expect(message).toBe("This is a Alpha configuration file and requires approval for modifications")
		})
	})

	describe("getInstructions", () => {
		it("should return formatted instructions about protected files", () => {
			const instructions = controller.getInstructions()

			expect(instructions).toContain("# Protected Files")
			expect(instructions).toContain("write-protected")
			expect(instructions).toContain(".alphaignore")
			expect(instructions).toContain(".alpha/**")
			expect(instructions).toContain("\u{1F6E1}") // Shield symbol
		})
	})

	describe("getProtectedPatterns", () => {
		it("should return the list of protected patterns", () => {
			const patterns = RooProtectedController.getProtectedPatterns()

			expect(patterns).toEqual([
				".alphaignore",
				".alphamodes",
				".alpharules*",
				".alpharules*",
				".alpha/**",
				".vscode/**",
				"*.code-workspace",
				".rooprotected",
				"AGENTS.md",
				"AGENT.md",
			])
		})
	})
})
