import * as path from "path"
import * as os from "os"
import * as fs from "fs/promises"

/** Captured host settings; project files cannot change their own discovery boundary. */
export interface ProjectInstructionDiscoveryOptions {
	projectRootMarkers?: readonly string[]
	projectDocFallbackFilenames?: readonly string[]
}

/** Keep discovery probes to basenames, including on Windows where ':' selects a stream. */
export function getSafeProjectInstructionFilenames(filenames: readonly string[]): string[] {
	if (!Array.isArray(filenames)) return []
	return Array.from(
		new Set(
			filenames.filter(
				(filename) =>
					typeof filename === "string" &&
					filename.length > 0 &&
					filename !== "." &&
					filename !== ".." &&
					!/[\\/\0:]/.test(filename),
			),
		),
	)
}

/** Canonical root for configuration created by Alpha in the current project. */
export function getProjectConfigDirectory(cwd: string): string {
	return path.join(cwd, ".alpha")
}

/** Resolve a canonical Alpha path without creating or rewriting configuration. */
export async function getProjectConfigPathForRead(cwd: string, relativePath: string): Promise<string> {
	const projectPath = path.join(getProjectConfigDirectory(cwd), relativePath)
	try {
		await fs.access(projectPath)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}
	return projectPath
}

/** Return the canonical project MCP path; discovery never writes configuration. */
export async function getProjectMcpConfigPath(cwd: string): Promise<string> {
	return getProjectConfigPathForRead(cwd, "mcp.json")
}

/** Canonical root for per-user Alpha configuration. */
export function getGlobalConfigDirectory(): string {
	return path.join(os.homedir(), ".alpha")
}

/**
 * Gets the global .agents directory path based on the current platform.
 * This is a shared directory for agent skills across different AI coding tools.
 *
 * @returns The absolute path to the global .agents directory
 *
 * @example Platform-specific paths:
 * ```
 * // macOS/Linux: ~/.agents/
 * // Example: /Users/john/.agents
 *
 * // Windows: %USERPROFILE%\.agents\
 * // Example: C:\Users\john\.agents
 * ```
 *
 * @example Usage:
 * ```typescript
 * const globalAgentsDir = getGlobalAgentsDirectory()
 * // Returns: "/Users/john/.agents" (on macOS/Linux)
 * // Returns: "C:\\Users\\john\\.agents" (on Windows)
 * ```
 */
export function getGlobalAgentsDirectory(): string {
	const homeDir = os.homedir()
	return path.join(homeDir, ".agents")
}

/**
 * Gets the project-local .agents directory path for a given cwd.
 * This is a shared directory for agent skills across different AI coding tools.
 *
 * @param cwd - Current working directory (project path)
 * @returns The absolute path to the project-local .agents directory
 *
 * @example
 * ```typescript
 * const projectAgentsDir = getProjectAgentsDirectoryForCwd('/Users/john/my-project')
 * // Returns: "/Users/john/my-project/.agents"
 * ```
 */
export function getProjectAgentsDirectoryForCwd(cwd: string): string {
	return path.join(cwd, ".agents")
}

/**
 * Checks if a directory exists
 */
export async function directoryExists(dirPath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(dirPath)
		return stat.isDirectory()
	} catch (error: any) {
		// Only catch expected "not found" errors
		if (error.code === "ENOENT" || error.code === "ENOTDIR") {
			return false
		}
		// Re-throw unexpected errors (permission, I/O, etc.)
		throw error
	}
}

/**
 * Checks if a file exists
 */
export async function fileExists(filePath: string): Promise<boolean> {
	try {
		const stat = await fs.stat(filePath)
		return stat.isFile()
	} catch (error: any) {
		// Only catch expected "not found" errors
		if (error.code === "ENOENT" || error.code === "ENOTDIR") {
			return false
		}
		// Re-throw unexpected errors (permission, I/O, etc.)
		throw error
	}
}

/**
 * Reads a file safely, returning null if it doesn't exist
 */
export async function readFileIfExists(filePath: string): Promise<string | null> {
	try {
		return await fs.readFile(filePath, "utf-8")
	} catch (error: any) {
		// Only catch expected "not found" errors
		if (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR") {
			return null
		}
		// Re-throw unexpected errors (permission, I/O, etc.)
		throw error
	}
}

/**
 * Discovers all .alpha directories in subdirectories of the workspace
 *
 * @param cwd - Current working directory (workspace root)
 * @returns Array of absolute paths to .alpha directories found in subdirectories,
 *          sorted alphabetically. Does not include the root .alpha directory.
 *
 * @example
 * ```typescript
 * const subfolderConfigs = await discoverSubfolderConfigDirectories('/Users/john/monorepo')
 * // Returns:
 * // [
 * //   '/Users/john/monorepo/package-a/.alpha',
 * //   '/Users/john/monorepo/package-b/.alpha',
 * //   '/Users/john/monorepo/packages/shared/.alpha'
 * // ]
 * ```
 *
 * @example Directory structure:
 * ```
 * /Users/john/monorepo/
 * ├── .alpha/                      # Root .alpha (NOT included - use getProjectConfigDirectory)
 * ├── package-a/
 * │   └── .alpha/                # Included
 * │       └── rules/
 * ├── package-b/
 * │   └── .alpha/                # Included
 * │       └── rules-code/
 * └── packages/
 *     └── shared/
 *         └── .alpha/            # Included (nested)
 *             └── rules/
 * ```
 */
export async function discoverSubfolderConfigDirectories(cwd: string): Promise<string[]> {
	try {
		// Dynamic import to avoid vscode dependency at module load time
		// This is necessary because file-search.ts imports vscode, which is not
		// available in the webview context
		const { executeRipgrep } = await import("../search/file-search")

		// Use ripgrep to find any file inside any .alpha directory
		// This efficiently discovers all .alpha folders regardless of their content
		const args = [
			"--files",
			"--hidden",
			"--follow",
			"-g",
			"**/.alpha/**",
			"-g",
			"!node_modules/**",
			"-g",
			"!.git/**",
			cwd,
		]

		const results = await executeRipgrep({ args, workspacePath: cwd })

		// Extract unique .alpha directory paths
		const configDirs = new Set<string>()
		const rootConfigDir = path.join(cwd, ".alpha")

		for (const result of results) {
			// Match paths like "subfolder/.alpha/anything" or "subfolder/nested/.alpha/anything"
			// Handle both forward slashes (Unix) and backslashes (Windows)
			const match = result.path.match(/^(.+?)[/\\]\.alpha[/\\]/)
			if (match) {
				const configDir = path.join(cwd, match[1], ".alpha")
				// Exclude the root .alpha directory (already handled by getProjectConfigDirectory)
				if (configDir !== rootConfigDir) {
					configDirs.add(configDir)
				}
			}
		}

		// Return sorted alphabetically
		return Array.from(configDirs).sort()
	} catch (error) {
		// If discovery fails (e.g., ripgrep not available), return empty array
		return []
	}
}

/**
 * Gets the ordered list of .alpha directories to check (global first, then project-local)
 *
 * @param cwd - Current working directory (project path)
 * @returns Array of directory paths to check in order [global, project-local]
 *
 * @example
 * ```typescript
 * // For a project at /Users/john/my-project
 * const directories = getConfigDirectoriesForCwd('/Users/john/my-project')
 * // Returns:
 * // [
 * //   '/Users/john/.alpha',           // Global directory
 * //   '/Users/john/my-project/.alpha' // Project-local directory
 * // ]
 * ```
 *
 * @example Directory structure:
 * ```
 * /Users/john/
 * ├── .alpha/                    # Global configuration
 * │   ├── rules/
 * │   │   └── rules.md
 * │   └── custom-instructions.md
 * └── my-project/
 *     ├── .alpha/                # Project-specific configuration
 *     │   ├── rules/
 *     │   │   └── rules.md     # Overrides global rules
 *     │   └── project-notes.md
 *     └── src/
 *         └── index.ts
 * ```
 */
export function getConfigDirectoriesForCwd(cwd: string): string[] {
	const directories: string[] = []

	// Add global directory first
	directories.push(getGlobalConfigDirectory())

	// Add project-local directory second
	directories.push(getProjectConfigDirectory(cwd))

	return directories
}

/**
 * Gets the ordered list of all .alpha directories including subdirectories
 *
 * @param cwd - Current working directory (project path)
 * @returns Array of directory paths in order: [global, project-local, ...subfolders (alphabetically)]
 *
 * @example
 * ```typescript
 * // For a monorepo at /Users/john/monorepo with .alpha in subfolders
 * const directories = await getAllConfigDirectoriesForCwd('/Users/john/monorepo')
 * // Returns:
 * // [
 * //   '/Users/john/.alpha',                    // Global directory
 * //   '/Users/john/monorepo/.alpha',           // Project-local directory
 * //   '/Users/john/monorepo/package-a/.alpha', // Subfolder (alphabetical)
 * //   '/Users/john/monorepo/package-b/.alpha'  // Subfolder (alphabetical)
 * // ]
 * ```
 */
export async function getAllConfigDirectoriesForCwd(cwd: string): Promise<string[]> {
	const directories: string[] = []

	// Add global directory first
	directories.push(getGlobalConfigDirectory())

	// Add project-local directory second
	directories.push(getProjectConfigDirectory(cwd))

	// Discover and add subfolder .alpha directories
	const subfolderDirs = await discoverSubfolderConfigDirectories(cwd)
	directories.push(...subfolderDirs)

	return directories
}

/**
 * Gets project instruction directories from the nearest .git root through cwd,
 * followed by parent directories of discovered subfolder .alpha directories.
 *
 * @param cwd - Current working directory (project path)
 * @returns Ordered directories to check for agent instruction files
 *
 * @example
 * ```typescript
 * const dirs = await getAgentsDirectoriesForCwd('/Users/john/monorepo')
 * // Returns: ['/Users/john/monorepo', '/Users/john/monorepo/package-a', ...]
 * ```
 */
export async function getAgentsDirectoriesForCwd(cwd: string): Promise<string[]> {
	const { directories } = await getProjectInstructionDirectoriesForCwd(cwd)

	// Get all subfolder .alpha directories
	const subfolderConfigDirs = await discoverSubfolderConfigDirectories(cwd)

	// Extract parent directories (remove .alpha from path)
	for (const configDir of subfolderConfigDirs) {
		const parentDir = path.dirname(configDir)
		if (!directories.some((directory) => path.resolve(directory) === path.resolve(parentDir))) {
			directories.push(parentDir)
		}
	}

	return directories
}

/**
 * Finds the nearest project root marked by a configured entry and returns its
 * directories from root to cwd. If no marker is found, cwd is the only
 * instruction directory.
 */
export async function getProjectInstructionDirectoriesForCwd(
	cwd: string,
	options: ProjectInstructionDiscoveryOptions = {},
): Promise<{ root: string; directories: string[] }> {
	const cwdPath = path.isAbsolute(cwd) ? cwd : path.resolve(cwd)
	const markers = getSafeProjectInstructionFilenames(options.projectRootMarkers ?? [".git"])
	let cursor = cwdPath
	let root = cwdPath

	while (markers.length > 0) {
		let foundMarker = false
		for (const name of markers) {
			try {
				const marker = await fs.stat(path.join(cursor, name))
				if (marker.isDirectory() || marker.isFile()) {
					root = cursor
					foundMarker = true
					break
				}
			} catch {
				// Project-root discovery is best effort; inaccessible or absent markers are ignored.
			}
		}
		if (foundMarker) break

		const parent = path.dirname(cursor)
		if (parent === cursor) break
		cursor = parent
	}
	if (root === cwdPath && cwdPath !== cwd) root = cwd

	const directories: string[] = []
	cursor = root === cwd ? cwd : cwdPath
	while (true) {
		directories.push(cursor)
		if (cursor === root) break
		const parent = path.dirname(cursor)
		if (parent === cursor) break
		cursor = parent
	}
	directories.reverse()

	return { root, directories }
}

/**
 * Loads configuration from multiple .alpha directories with project overriding global
 *
 * @param relativePath - The relative path within each .alpha directory (e.g., 'rules/rules.md')
 * @param cwd - Current working directory (project path)
 * @returns Object with global and project content, plus merged content
 *
 * @example
 * ```typescript
 * // Load rules configuration for a project
 * const config = await loadConfiguration('rules/rules.md', '/Users/john/my-project')
 *
 * // Returns:
 * // {
 * //   global: "Global rules content...",     // From ~/.alpha/rules/rules.md
 * //   project: "Project rules content...",   // From /Users/john/my-project/.alpha/rules/rules.md
 * //   merged: "Global rules content...\n\n# Project-specific rules (override global):\n\nProject rules content..."
 * // }
 * ```
 *
 * @example File paths resolved:
 * ```
 * relativePath: 'rules/rules.md'
 * cwd: '/Users/john/my-project'
 *
 * Reads from:
 * - Global: /Users/john/.alpha/rules/rules.md
 * - Project: /Users/john/my-project/.alpha/rules/rules.md
 *
 * Other common relativePath examples:
 * - 'custom-instructions.md'
 * - 'config/settings.json'
 * - 'templates/component.tsx'
 * ```
 *
 * @example Merging behavior:
 * ```
 * // If only global exists:
 * { global: "content", project: null, merged: "content" }
 *
 * // If only project exists:
 * { global: null, project: "content", merged: "content" }
 *
 * // If both exist:
 * {
 *   global: "global content",
 *   project: "project content",
 *   merged: "global content\n\n# Project-specific rules (override global):\n\nproject content"
 * }
 * ```
 */
export async function loadConfiguration(
	relativePath: string,
	cwd: string,
): Promise<{
	global: string | null
	project: string | null
	merged: string
}> {
	const globalDir = getGlobalConfigDirectory()
	const projectDir = getProjectConfigDirectory(cwd)

	const globalFilePath = path.join(globalDir, relativePath)
	const projectFilePath = path.join(projectDir, relativePath)

	// Read global configuration
	const globalContent = await readFileIfExists(globalFilePath)

	// Read project-local configuration
	const projectContent = await readFileIfExists(projectFilePath)

	// Merge configurations - project overrides global
	let merged = ""

	if (globalContent) {
		merged += globalContent
	}

	if (projectContent) {
		if (merged) {
			merged += "\n\n# Project-specific rules (override global):\n\n"
		}
		merged += projectContent
	}

	return {
		global: globalContent,
		project: projectContent,
		merged: merged || "",
	}
}
