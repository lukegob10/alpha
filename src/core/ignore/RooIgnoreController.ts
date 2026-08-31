import path from "path"
import { fileExistsAtPath } from "../../utils/fs"
import fs from "fs/promises"
import ignore, { Ignore } from "ignore"
import * as vscode from "vscode"

import { analyzeShellCommands, tokenizeShellCommands } from "../auto-approval/shellCommand"
import { getPathRelativeToRoot, resolvePathWithExistingAncestor } from "../tools/pathSafety"

export const LOCK_TEXT_SYMBOL = "\u{1F512}"

/**
 * Controls LLM access to files by enforcing ignore patterns.
 * Designed to be instantiated once in Alpha.ts and passed to file manipulation services.
 * Uses the 'ignore' library to support standard .gitignore syntax in .alphaignore files.
 */
export class RooIgnoreController {
	private cwd: string
	private ignoreInstance: Ignore
	private disposables: vscode.Disposable[] = []
	private loadGeneration = 0
	rooIgnoreContent: string | undefined

	constructor(cwd: string) {
		this.cwd = cwd
		this.ignoreInstance = ignore()
		this.rooIgnoreContent = undefined
		// Set up file watcher for .alphaignore
		this.setupFileWatcher()
	}

	/**
	 * Initialize the controller by loading custom patterns
	 * Must be called after construction and before using the controller
	 */
	async initialize(): Promise<void> {
		await this.loadRooIgnore()
	}

	/**
	 * Set up the file watcher for .alphaignore changes
	 */
	private setupFileWatcher(): void {
		const rooignorePattern = new vscode.RelativePattern(this.cwd, ".alphaignore")
		const fileWatcher = vscode.workspace.createFileSystemWatcher(rooignorePattern)

		// Watch for changes and updates
		this.disposables.push(
			fileWatcher.onDidChange(() => {
				this.loadRooIgnore()
			}),
			fileWatcher.onDidCreate(() => {
				this.loadRooIgnore()
			}),
			fileWatcher.onDidDelete(() => {
				this.loadRooIgnore()
			}),
		)

		// Add fileWatcher itself to disposables
		this.disposables.push(fileWatcher)
	}

	/**
	 * Load custom patterns from .alphaignore if it exists
	 */
	private async loadRooIgnore(): Promise<void> {
		const generation = ++this.loadGeneration
		try {
			const ignorePath = path.join(this.cwd, ".alphaignore")
			if (await fileExistsAtPath(ignorePath)) {
				const content = await fs.readFile(ignorePath, "utf8")
				const nextIgnoreInstance = ignore().add(content).add(".alphaignore")
				if (generation !== this.loadGeneration) return

				this.rooIgnoreContent = content
				this.ignoreInstance = nextIgnoreInstance
			} else {
				if (generation !== this.loadGeneration) return

				this.rooIgnoreContent = undefined
				this.ignoreInstance = ignore()
			}
		} catch (error) {
			// Retain the last known-good policy if the file cannot be reloaded.
			console.error("Unexpected error loading .alphaignore:", error)
		}
	}

	/**
	 * Check if a file should be accessible to the LLM
	 * Automatically resolves symlinks
	 * @param filePath - Path to check (relative to cwd)
	 * @returns true if file is accessible, false if ignored
	 */
	validateAccess(filePath: string): boolean {
		// Always allow access if .alphaignore does not exist
		if (this.rooIgnoreContent === undefined) {
			return true
		}
		try {
			const absolutePath = path.resolve(this.cwd, filePath)
			const lexicalRelativePath = getPathRelativeToRoot(this.cwd, absolutePath)

			if (lexicalRelativePath !== undefined && this.ignoreInstance.ignores(lexicalRelativePath)) {
				return false
			}

			// Follow symlinks and junctions, including for a not-yet-created file.
			const realRoot = resolvePathWithExistingAncestor(this.cwd)
			const realPath = resolvePathWithExistingAncestor(absolutePath)
			const relativePath = getPathRelativeToRoot(realRoot, realPath)

			// Ignore policy is workspace-relative. Outside targets are handled by the
			// separate outside-workspace approval boundary.
			return relativePath === undefined || !this.ignoreInstance.ignores(relativePath)
		} catch (error) {
			// Allow access to files outside cwd or on errors (backward compatibility)
			return true
		}
	}

	/**
	 * Check if a terminal command should be allowed to execute based on file access patterns
	 * @param command - Terminal command to validate
	 * @returns path of file that is being accessed if it is being accessed, undefined if command is allowed
	 */
	validateCommand(command: string): string | undefined {
		// Always allow if no .alphaignore exists
		if (this.rooIgnoreContent === undefined) {
			return undefined
		}

		// Commands that read file contents
		const fileReadingCommands = [
			// Unix commands
			"cat",
			"less",
			"more",
			"head",
			"tail",
			"grep",
			"awk",
			"sed",
			// PowerShell commands and aliases
			"get-content",
			"gc",
			"type",
			"select-string",
			"sls",
		]

		const shellAnalysis = analyzeShellCommands(command)
		const commandSources = [command, ...shellAnalysis.commands]
		for (const parts of commandSources.flatMap((source) => tokenizeShellCommands(source))) {
			if (parts.length === 0 || !fileReadingCommands.includes(parts[0].toLowerCase())) continue

			// Check each argument that could be a file path.
			for (const argument of parts.slice(1)) {
				const inlinePathParameter = argument.match(/^-(?:LiteralPath|Path):(.+)$/i)
				if (argument.startsWith("-") && !inlinePathParameter) continue
				const candidatePath = inlinePathParameter?.[1] ?? argument
				if (!this.validateAccess(candidatePath)) {
					return candidatePath
				}
			}
		}
		if (shellAnalysis.malformedSubstitution) {
			return "malformed shell substitution"
		}

		return undefined
	}

	/**
	 * Filter an array of paths, removing those that should be ignored
	 * @param paths - Array of paths to filter (relative to cwd)
	 * @returns Array of allowed paths
	 */
	filterPaths(paths: string[]): string[] {
		try {
			return paths
				.map((p) => ({
					path: p,
					allowed: this.validateAccess(p),
				}))
				.filter((x) => x.allowed)
				.map((x) => x.path)
		} catch (error) {
			console.error("Error filtering paths:", error)
			return [] // Fail closed for security
		}
	}

	/**
	 * Clean up resources when the controller is no longer needed
	 */
	dispose(): void {
		this.loadGeneration++
		this.disposables.forEach((d) => d.dispose())
		this.disposables = []
	}

	/**
	 * Get formatted instructions about the .alphaignore file for the LLM
	 * @returns Formatted instructions or undefined if .alphaignore doesn't exist
	 */
	getInstructions(): string | undefined {
		if (this.rooIgnoreContent === undefined) {
			return undefined
		}

		return `# .alphaignore\n\n(The following is provided by a root-level .alphaignore file where the user has specified files and directories that should not be accessed. When using list_files, you'll notice a ${LOCK_TEXT_SYMBOL} next to files that are blocked. Attempting to access the file's contents e.g. through read_file will result in an error.)\n\n${this.rooIgnoreContent}\n.alphaignore`
	}
}
