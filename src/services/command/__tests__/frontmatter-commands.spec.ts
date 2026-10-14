import fs from "fs/promises"
import * as path from "path"

import { getCommand, getCommands } from "../commands"

// Mock fs and path modules
vi.mock("fs/promises")
vi.mock("../config-paths", () => ({
	getLegacyGlobalConfigDirectory: vi.fn(() => "/mock/global/.roo"),
	getLegacyProjectConfigDirectory: vi.fn(() => "/mock/project/.roo"),
}))
vi.mock("../built-in-commands", () => ({
	getBuiltInCommands: vi.fn(() => Promise.resolve([])),
	getBuiltInCommand: vi.fn(() => Promise.resolve(undefined)),
	getBuiltInCommandNames: vi.fn(() => Promise.resolve([])),
}))

const mockFs = vi.mocked(fs)

describe("Command loading with frontmatter", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("getCommand with frontmatter", () => {
		it("prefers an Alpha project command over a legacy command with the same name", async () => {
			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readFile = vi
				.fn()
				.mockImplementation(async (filePath) =>
					String(filePath).includes(path.join(".alpha", "commands"))
						? "Alpha project command"
						: "Legacy command",
				)
			const command = await getCommand("/test/cwd", "setup")
			expect(command?.content).toBe("Alpha project command")
			expect(command?.filePath).toBe(path.join("/test/cwd", ".alpha", "commands", "setup.md"))
		})

		it("keeps a legacy project command available when the Alpha command is absent", async () => {
			mockFs.stat = vi.fn().mockImplementation(async (directory) => ({
				isDirectory: () => String(directory).includes(path.join(".roo", "commands")),
			}))
			mockFs.readFile = vi.fn().mockResolvedValue("Legacy project command")
			const command = await getCommand("/test/cwd", "setup")
			expect(command?.content).toBe("Legacy project command")
			expect(command?.source).toBe("project")
			expect(command?.filePath).toBe(path.join("/test/cwd", ".roo", "commands", "setup.md"))
		})

		it("lists Alpha commands with matching precedence while retaining unique legacy commands", async () => {
			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readdir = vi.fn().mockImplementation(async (directory) => {
				if (!String(directory).startsWith(path.join("/test/cwd"))) return []
				const names = String(directory).includes(".alpha") ? ["setup.md"] : ["setup.md", "legacy-only.md"]
				return names.map((name) => ({ name, isFile: () => true, isSymbolicLink: () => false }))
			})
			mockFs.readFile = vi
				.fn()
				.mockImplementation(async (filePath) =>
					String(filePath).includes(".alpha") ? "Alpha command" : "Legacy command",
				)
			const commands = await getCommands("/test/cwd")
			expect(commands.find((command) => command.name === "setup")?.content).toBe("Alpha command")
			expect(commands.find((command) => command.name === "legacy-only")?.content).toBe("Legacy command")
		})

		it.each(["../outside", "..\\outside", "/absolute", "folder/command", "folder\\command"])(
			"should reject path-like command name %s before filesystem access",
			async (name) => {
				;(mockFs as any).stat = vi.fn()
				;(mockFs as any).readFile = vi.fn()
				const result = await getCommand("/test/cwd", name)

				expect(result).toBeUndefined()
				expect(mockFs.stat).not.toHaveBeenCalled()
				expect(mockFs.readFile).not.toHaveBeenCalled()
			},
		)

		it("should load command with description from frontmatter", async () => {
			const commandContent = `---
description: Sets up the development environment
author: John Doe
---

# Setup Command

Run the following commands:
\`\`\`bash
npm install
npm run build
\`\`\``

			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readFile = vi.fn().mockResolvedValue(commandContent)

			const result = await getCommand("/test/cwd", "setup")

			expect(result).toEqual({
				name: "setup",
				content: "# Setup Command\n\nRun the following commands:\n```bash\nnpm install\nnpm run build\n```",
				source: "project",
				filePath: path.join("/test/cwd", ".alpha", "commands", "setup.md"),
				description: "Sets up the development environment",
				argumentHint: undefined,
				mode: undefined,
			})
		})

		it("should load command without frontmatter", async () => {
			const commandContent = `# Setup Command

Run the following commands:
\`\`\`bash
npm install
npm run build
\`\`\``

			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readFile = vi.fn().mockResolvedValue(commandContent)

			const result = await getCommand("/test/cwd", "setup")

			expect(result).toEqual({
				name: "setup",
				content: "# Setup Command\n\nRun the following commands:\n```bash\nnpm install\nnpm run build\n```",
				source: "project",
				filePath: path.join("/test/cwd", ".alpha", "commands", "setup.md"),
				description: undefined,
				argumentHint: undefined,
				mode: undefined,
			})
		})

		it("should handle empty description in frontmatter", async () => {
			const commandContent = `---
description: ""
author: John Doe
---

# Setup Command

Command content here.`

			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readFile = vi.fn().mockResolvedValue(commandContent)

			const result = await getCommand("/test/cwd", "setup")

			expect(result?.description).toBeUndefined()
		})

		it("should handle malformed frontmatter gracefully", async () => {
			const commandContent = `---
description: Test
invalid: yaml: [
---

# Setup Command

Command content here.`

			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readFile = vi.fn().mockResolvedValue(commandContent)

			const result = await getCommand("/test/cwd", "setup")

			expect(result).toEqual({
				name: "setup",
				content: commandContent.trim(),
				source: "project",
				filePath: path.join("/test/cwd", ".alpha", "commands", "setup.md"),
				description: undefined,
				argumentHint: undefined,
				mode: undefined,
			})
		})

		it("should prioritize project commands over global commands", async () => {
			const projectCommandContent = `---
description: Project-specific setup
---

# Project Setup

Project-specific setup instructions.`

			const globalCommandContent = `---
description: Global setup
---

# Global Setup

Global setup instructions.`

			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readFile = vi
				.fn()
				.mockResolvedValueOnce(projectCommandContent) // First call for project
				.mockResolvedValueOnce(globalCommandContent) // Second call for global (shouldn't be used)

			const result = await getCommand("/test/cwd", "setup")

			expect(result).toEqual({
				name: "setup",
				content: "# Project Setup\n\nProject-specific setup instructions.",
				source: "project",
				filePath: path.join("/test/cwd", ".alpha", "commands", "setup.md"),
				description: "Project-specific setup",
				argumentHint: undefined,
				mode: undefined,
			})
		})

		it("should fall back to global command if project command doesn't exist", async () => {
			const globalCommandContent = `---
description: Global setup command
---

# Global Setup

Global setup instructions.`

			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readFile = vi.fn().mockImplementation(async (filePath) => {
				if (String(filePath).startsWith(path.join("/test/cwd"))) throw new Error("File not found")
				return globalCommandContent
			})

			const result = await getCommand("/test/cwd", "setup")

			expect(result).toEqual({
				name: "setup",
				content: "# Global Setup\n\nGlobal setup instructions.",
				source: "global",
				filePath: expect.stringContaining(path.join(".roo", "commands", "setup.md")),
				description: "Global setup command",
				argumentHint: undefined,
				mode: undefined,
			})
		})
	})

	describe("argument-hint functionality", () => {
		it("should load command with argument-hint from frontmatter", async () => {
			const commandContent = `---
description: Create a new release of the Alpha extension
argument-hint: patch | minor | major
---

# Release Command

Create a new release.`

			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readFile = vi.fn().mockResolvedValue(commandContent)

			const result = await getCommand("/test/cwd", "release")

			expect(result).toEqual({
				name: "release",
				content: "# Release Command\n\nCreate a new release.",
				source: "project",
				filePath: path.join("/test/cwd", ".alpha", "commands", "release.md"),
				description: "Create a new release of the Alpha extension",
				argumentHint: "patch | minor | major",
				mode: undefined,
			})
		})

		it("should handle command with both description and argument-hint", async () => {
			const commandContent = `---
description: Deploy application to environment
argument-hint: staging | production
author: DevOps Team
---

# Deploy Command

Deploy the application.`

			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readFile = vi.fn().mockResolvedValue(commandContent)

			const result = await getCommand("/test/cwd", "deploy")

			expect(result).toEqual({
				name: "deploy",
				content: "# Deploy Command\n\nDeploy the application.",
				source: "project",
				filePath: path.join("/test/cwd", ".alpha", "commands", "deploy.md"),
				description: "Deploy application to environment",
				argumentHint: "staging | production",
				mode: undefined,
			})
		})

		it("should handle empty argument-hint in frontmatter", async () => {
			const commandContent = `---
description: Test command
argument-hint: ""
---

# Test Command

Test content.`

			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readFile = vi.fn().mockResolvedValue(commandContent)

			const result = await getCommand("/test/cwd", "test")

			expect(result?.argumentHint).toBeUndefined()
		})

		it("should handle whitespace-only argument-hint in frontmatter", async () => {
			const commandContent = `---
description: Test command
argument-hint: "   "
---

# Test Command

Test content.`

			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readFile = vi.fn().mockResolvedValue(commandContent)

			const result = await getCommand("/test/cwd", "test")

			expect(result?.argumentHint).toBeUndefined()
		})

		it("should handle non-string argument-hint in frontmatter", async () => {
			const commandContent = `---
description: Test command
argument-hint: 123
---

# Test Command

Test content.`

			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readFile = vi.fn().mockResolvedValue(commandContent)

			const result = await getCommand("/test/cwd", "test")

			expect(result?.argumentHint).toBeUndefined()
		})

		it("should load command with mode from frontmatter", async () => {
			const commandContent = `---
description: Debug the application
mode: debug
---

# Debug Command

Start debugging.`

			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readFile = vi.fn().mockResolvedValue(commandContent)

			const result = await getCommand("/test/cwd", "debug-app")

			expect(result).toEqual({
				name: "debug-app",
				content: "# Debug Command\n\nStart debugging.",
				source: "project",
				filePath: path.join("/test/cwd", ".alpha", "commands", "debug-app.md"),
				description: "Debug the application",
				argumentHint: undefined,
				mode: "debug",
			})
		})

		it("should handle empty mode in frontmatter", async () => {
			const commandContent = `---
description: Test command
mode: ""
---

# Test Command

Test content.`

			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readFile = vi.fn().mockResolvedValue(commandContent)

			const result = await getCommand("/test/cwd", "test")

			expect(result?.mode).toBeUndefined()
		})

		it("should handle command with description, argument-hint, and mode", async () => {
			const commandContent = `---
description: Deploy to environment
argument-hint: staging | production
mode: code
---

# Deploy Command

Deploy the application.`

			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readFile = vi.fn().mockResolvedValue(commandContent)

			const result = await getCommand("/test/cwd", "deploy")

			expect(result).toEqual({
				name: "deploy",
				content: "# Deploy Command\n\nDeploy the application.",
				source: "project",
				filePath: path.join("/test/cwd", ".alpha", "commands", "deploy.md"),
				description: "Deploy to environment",
				argumentHint: "staging | production",
				mode: "code",
			})
		})
	})

	describe("getCommands with frontmatter", () => {
		it("should load multiple commands with descriptions", async () => {
			const setupContent = `---
description: Sets up the development environment
---

# Setup Command

Setup instructions.`

			const deployContent = `---
description: Deploys the application to production
---

# Deploy Command

Deploy instructions.`

			const buildContent = `# Build Command

Build instructions without frontmatter.`

			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readdir = vi.fn().mockResolvedValue([
				{ name: "setup.md", isFile: () => true },
				{ name: "deploy.md", isFile: () => true },
				{ name: "build.md", isFile: () => true },
				{ name: "not-markdown.txt", isFile: () => true }, // Should be ignored
			])
			mockFs.readFile = vi
				.fn()
				.mockResolvedValueOnce(setupContent)
				.mockResolvedValueOnce(deployContent)
				.mockResolvedValueOnce(buildContent)

			const result = await getCommands("/test/cwd")

			expect(result).toHaveLength(3)
			expect(result).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "setup",
						description: "Sets up the development environment",
						argumentHint: undefined,
					}),
					expect.objectContaining({
						name: "deploy",
						description: "Deploys the application to production",
						argumentHint: undefined,
					}),
					expect.objectContaining({
						name: "build",
						description: undefined,
						argumentHint: undefined,
					}),
				]),
			)
		})

		it("should load multiple commands with argument hints", async () => {
			const releaseContent = `---
description: Create a new release
argument-hint: patch | minor | major
---

# Release Command

Create a release.`

			const deployContent = `---
description: Deploy to environment
argument-hint: staging | production
---

# Deploy Command

Deploy the app.`

			mockFs.stat = vi.fn().mockResolvedValue({ isDirectory: () => true })
			mockFs.readdir = vi.fn().mockResolvedValue([
				{ name: "release.md", isFile: () => true },
				{ name: "deploy.md", isFile: () => true },
			])
			mockFs.readFile = vi.fn().mockResolvedValueOnce(releaseContent).mockResolvedValueOnce(deployContent)

			const result = await getCommands("/test/cwd")

			expect(result).toHaveLength(2)
			expect(result).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "release",
						description: "Create a new release",
						argumentHint: "patch | minor | major",
					}),
					expect.objectContaining({
						name: "deploy",
						description: "Deploy to environment",
						argumentHint: "staging | production",
					}),
				]),
			)
		})
	})
})
