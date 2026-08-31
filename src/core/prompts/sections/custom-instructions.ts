import fs from "fs/promises"
import path from "path"
import * as os from "os"
import { Dirent } from "fs"

import { isLanguage } from "@alpha-code/types"

import type { SystemPromptSettings } from "../types"

import { LANGUAGES } from "../../../shared/language"
import {
	getAllRooDirectoriesForCwd,
	getAgentsDirectoriesForCwd,
	getGlobalRooDirectory,
} from "../../../services/roo-config"

/**
 * Safely read a file and return its trimmed content
 */
async function safeReadFile(filePath: string): Promise<string> {
	try {
		const content = await fs.readFile(filePath, "utf-8")
		return content.trim()
	} catch (err) {
		const errorCode = (err as NodeJS.ErrnoException).code
		if (!errorCode || !["ENOENT", "EISDIR"].includes(errorCode)) {
			throw err
		}
		return ""
	}
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
	const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath))
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath))
	)
}

async function resolvePathWithinRoot(filePath: string, trustedRoot: string): Promise<string | undefined> {
	try {
		const [realRoot, realPath] = await Promise.all([fs.realpath(trustedRoot), fs.realpath(filePath)])
		return isPathWithinRoot(realRoot, realPath) ? realPath : undefined
	} catch {
		return undefined
	}
}

async function safeReadFileWithinRoot(filePath: string, trustedRoot: string): Promise<string> {
	const resolvedPath = await resolvePathWithinRoot(filePath, trustedRoot)
	return resolvedPath ? safeReadFile(resolvedPath) : ""
}

function getRuleTrustRoot(cwd: string, configDirectory: string): string {
	return isPathWithinRoot(cwd, configDirectory) ? cwd : configDirectory
}

/**
 * Check if a directory exists
 */
async function directoryExists(dirPath: string): Promise<boolean> {
	try {
		const stats = await fs.stat(dirPath)
		return stats.isDirectory()
	} catch (err) {
		return false
	}
}

const MAX_DEPTH = 5

/**
 * Recursively resolve directory entries and collect file paths
 */
async function resolveDirectoryEntry(
	entry: Dirent,
	dirPath: string,
	fileInfo: Array<{ originalPath: string; resolvedPath: string }>,
	depth: number,
	trustedRoot: string,
): Promise<void> {
	// Avoid cyclic symlinks
	if (depth > MAX_DEPTH) {
		return
	}

	const fullPath = path.resolve(entry.parentPath || dirPath, entry.name)
	if (entry.isFile()) {
		// Regular file - both original and resolved paths are the same
		fileInfo.push({ originalPath: fullPath, resolvedPath: fullPath })
	} else if (entry.isSymbolicLink()) {
		// Await the resolution of the symbolic link
		await resolveSymLink(fullPath, fileInfo, depth + 1, trustedRoot)
	}
}

/**
 * Recursively resolve a symbolic link and collect file paths
 */
async function resolveSymLink(
	symlinkPath: string,
	fileInfo: Array<{ originalPath: string; resolvedPath: string }>,
	depth: number,
	trustedRoot: string,
): Promise<void> {
	// Avoid cyclic symlinks
	if (depth > MAX_DEPTH) {
		return
	}
	try {
		// Get the symlink target
		const linkTarget = await fs.readlink(symlinkPath)
		// Resolve the target path (relative to the symlink location)
		const targetPath = path.resolve(path.dirname(symlinkPath), linkTarget)
		const resolvedTarget = await resolvePathWithinRoot(targetPath, trustedRoot)
		if (!resolvedTarget) {
			return
		}

		// Check if the target is a file
		const stats = await fs.stat(resolvedTarget)
		if (stats.isFile()) {
			// For symlinks to files, store the symlink path as original and target as resolved
			fileInfo.push({
				originalPath: symlinkPath,
				resolvedPath: resolvedTarget,
			})
		} else if (stats.isDirectory()) {
			const anotherEntries = await fs.readdir(resolvedTarget, {
				withFileTypes: true,
				recursive: true,
			})
			// Collect promises for recursive calls within the directory
			const directoryPromises: Promise<void>[] = []
			for (const anotherEntry of anotherEntries) {
				directoryPromises.push(
					resolveDirectoryEntry(anotherEntry, resolvedTarget, fileInfo, depth + 1, trustedRoot),
				)
			}
			// Wait for all entries in the resolved directory to be processed
			await Promise.all(directoryPromises)
		} else if (stats.isSymbolicLink()) {
			// Handle nested symlinks by awaiting the recursive call
			await resolveSymLink(resolvedTarget, fileInfo, depth + 1, trustedRoot)
		}
	} catch (err) {
		// Skip invalid symlinks
	}
}

/**
 * Read all text files from a directory in alphabetical order
 */
async function readTextFilesFromDirectory(
	dirPath: string,
	trustedRoot: string,
): Promise<Array<{ filename: string; content: string }>> {
	try {
		const resolvedDirectory = await resolvePathWithinRoot(dirPath, trustedRoot)
		if (!resolvedDirectory) {
			return []
		}

		const entries = await fs.readdir(resolvedDirectory, {
			withFileTypes: true,
			recursive: true,
		})

		// Process all entries - regular files and symlinks that might point to files
		// Store both original path (for sorting) and resolved path (for reading)
		const fileInfo: Array<{ originalPath: string; resolvedPath: string }> = []
		// Collect promises for the initial resolution calls
		const initialPromises: Promise<void>[] = []

		for (const entry of entries) {
			initialPromises.push(resolveDirectoryEntry(entry, resolvedDirectory, fileInfo, 0, trustedRoot))
		}

		// Wait for all asynchronous operations (including recursive ones) to complete
		await Promise.all(initialPromises)

		const fileContents = await Promise.all(
			fileInfo.map(async ({ originalPath, resolvedPath }) => {
				try {
					// Check if it's a file (not a directory)
					const stats = await fs.stat(resolvedPath)
					if (stats.isFile()) {
						// Filter out cache files and system files that shouldn't be in rules
						if (!shouldIncludeRuleFile(resolvedPath)) {
							return null
						}
						const content = await safeReadFile(resolvedPath)
						// Use resolvedPath for display to maintain existing behavior
						return { filename: resolvedPath, content, sortKey: originalPath }
					}
					return null
				} catch (err) {
					return null
				}
			}),
		)

		// Filter out null values (directories, failed reads, or excluded files)
		const filteredFiles = fileContents.filter(
			(item): item is { filename: string; content: string; sortKey: string } => item !== null,
		)

		// Sort files alphabetically by the original filename (case-insensitive) to ensure consistent order
		// For symlinks, this will use the symlink name, not the target name
		return filteredFiles
			.sort((a, b) => {
				const filenameA = path.basename(a.sortKey).toLowerCase()
				const filenameB = path.basename(b.sortKey).toLowerCase()
				return filenameA.localeCompare(filenameB)
			})
			.map(({ filename, content }) => ({ filename, content }))
	} catch (err) {
		return []
	}
}

/**
 * Format content from multiple files with filenames as headers
 * @param files - Array of files with filename (absolute path) and content
 * @param cwd - Current working directory for computing relative paths
 */
function formatDirectoryContent(files: Array<{ filename: string; content: string }>, cwd: string): string {
	if (files.length === 0) return ""

	return files
		.map((file) => {
			// Compute relative path for display
			const displayPath = path.relative(cwd, file.filename)
			return `# Rules from ${displayPath}:\n${file.content}`
		})
		.join("\n\n")
}

function getAlphaDirectoriesForCwd(cwd: string): string[] {
	return [path.join(os.homedir(), ".alpha"), path.join(cwd, ".alpha")]
}

async function getRuleDirectoriesForCwd(cwd: string, enableSubfolderRules: boolean): Promise<string[]> {
	const alphaDirectories = getAlphaDirectoriesForCwd(cwd)

	if (!enableSubfolderRules) {
		return alphaDirectories
	}

	const legacyDirectories = await getAllRooDirectoriesForCwd(cwd)
	const alphaSubfolders = legacyDirectories
		.map((dir) => {
			const parent = path.dirname(dir)
			return path.join(parent, ".alpha")
		})
		.filter((dir) => !alphaDirectories.includes(dir))

	return [...alphaDirectories, ...alphaSubfolders]
}

/**
 * Load rule files from global, project-local, and optionally subfolder directories
 * Rules are loaded in order: global first, then project-local, then subfolders (alphabetically)
 *
 * @param cwd - Current working directory (project root)
 * @param enableSubfolderRules - Whether to include rules from subdirectories (default: false)
 */
export async function loadRuleFiles(cwd: string, enableSubfolderRules: boolean = false): Promise<string> {
	const rules: string[] = []
	// Use recursive discovery only if enableSubfolderRules is true
	const alphaDirectories = await getRuleDirectoriesForCwd(cwd, enableSubfolderRules)
	const legacyDirectories = enableSubfolderRules
		? await getAllRooDirectoriesForCwd(cwd)
		: [getGlobalRooDirectory(), path.join(cwd, ".roo")]

	// Check for .alpha/rules/ directories in order (global, project-local, and optionally subfolders)
	for (const alphaDir of alphaDirectories) {
		const rulesDir = path.join(alphaDir, "rules")
		if (await directoryExists(rulesDir)) {
			const files = await readTextFilesFromDirectory(rulesDir, getRuleTrustRoot(cwd, alphaDir))
			if (files.length > 0) {
				const content = formatDirectoryContent(files, cwd)
				rules.push(content)
			}
		}
	}

	// If we found rules in .alpha/rules/ directories, return them
	if (rules.length > 0) {
		return "\n# Rules from .alpha directories:\n\n" + rules.join("\n\n")
	}

	for (const legacyDir of legacyDirectories) {
		const rulesDir = path.join(legacyDir, "rules")
		if (await directoryExists(rulesDir)) {
			const files = await readTextFilesFromDirectory(rulesDir, getRuleTrustRoot(cwd, legacyDir))
			if (files.length > 0) {
				const content = formatDirectoryContent(files, cwd)
				rules.push(content)
			}
		}
	}

	if (rules.length > 0) {
		return "\n# Rules from legacy .roo directories:\n\n" + rules.join("\n\n")
	}

	// Fall back to existing behavior for legacy .alpharules/.clinerules files.
	const ruleFiles = [".alpharules", ".clinerules"]

	for (const file of ruleFiles) {
		const content = await safeReadFileWithinRoot(path.join(cwd, file), cwd)
		if (content) {
			return `\n# Rules from ${file}:\n${content}\n`
		}
	}

	return ""
}

/**
 * Read content from an agent rules file (AGENTS.md, AGENT.md, etc.)
 * Handles symlink resolution.
 *
 * @param filePath - Full path to the agent rules file
 * @returns File content or empty string if file doesn't exist
 */
async function readAgentRulesFile(filePath: string, trustedRoot: string): Promise<string> {
	try {
		await fs.lstat(filePath)
	} catch {
		return ""
	}

	const resolvedPath = await resolvePathWithinRoot(filePath, trustedRoot)
	return resolvedPath ? safeReadFile(resolvedPath) : ""
}

/**
 * Load AGENTS.md or AGENT.md file from a specific directory
 * Checks for both AGENTS.md (standard) and AGENT.md (alternative) for compatibility
 * Also loads AGENTS.local.md for personal overrides (not checked in to version control)
 * AGENTS.local.md can be loaded even if AGENTS.md doesn't exist
 *
 * @param directory - Directory to check for AGENTS.md
 * @param showPath - Whether to include the directory path in the header
 * @param cwd - Current working directory for computing relative paths (optional)
 */
async function loadAgentRulesFileFromDirectory(
	directory: string,
	showPath: boolean = false,
	cwd?: string,
): Promise<string> {
	// Try both filenames - AGENTS.md (standard) first, then AGENT.md (alternative)
	const filenames = ["AGENTS.md", "AGENT.md"]
	const results: string[] = []
	const displayPath = cwd ? path.relative(cwd, directory) : directory

	for (const filename of filenames) {
		try {
			const agentPath = path.join(directory, filename)
			const content = await readAgentRulesFile(agentPath, cwd ?? directory)

			if (content) {
				// Compute relative path for display if cwd is provided
				const header = showPath
					? `# Agent Rules Standard (${filename}) from ${displayPath}:`
					: `# Agent Rules Standard (${filename}):`
				results.push(`${header}\n${content}`)

				// Found a standard file, don't check alternative
				break
			}
		} catch (err) {
			// Silently ignore errors - agent rules files are optional
		}
	}

	// Always try to load AGENTS.local.md for personal overrides (even if AGENTS.md doesn't exist)
	try {
		const localFilename = "AGENTS.local.md"
		const localPath = path.join(directory, localFilename)
		const localContent = await readAgentRulesFile(localPath, cwd ?? directory)

		if (localContent) {
			const localHeader = showPath
				? `# Agent Rules Local (${localFilename}) from ${displayPath}:`
				: `# Agent Rules Local (${localFilename}):`
			results.push(`${localHeader}\n${localContent}`)
		}
	} catch (err) {
		// Silently ignore errors - local agent rules file is optional
	}

	return results.join("\n\n")
}

/**
 * Load AGENTS.md or AGENT.md file from the project root if it exists
 * Checks for both AGENTS.md (standard) and AGENT.md (alternative) for compatibility
 *
 * @deprecated Use loadAllAgentRulesFiles for loading from all directories
 */
async function loadAgentRulesFile(cwd: string): Promise<string> {
	return loadAgentRulesFileFromDirectory(cwd, false, cwd)
}

/**
 * Load all AGENTS.md files from project root and optionally subdirectories with .roo folders
 * Returns combined content with clear path headers for each file
 *
 * @param cwd - Current working directory (project root)
 * @param enableSubfolderRules - Whether to include AGENTS.md from subdirectories (default: false)
 * @returns Combined AGENTS.md content from all locations
 */
async function loadAllAgentRulesFiles(cwd: string, enableSubfolderRules: boolean = false): Promise<string> {
	const agentRules: string[] = []

	// When subfolder rules are disabled, only load from root
	if (!enableSubfolderRules) {
		const content = await loadAgentRulesFileFromDirectory(cwd, false, cwd)
		if (content && content.trim()) {
			agentRules.push(content.trim())
		}
		return agentRules.join("\n\n")
	}

	// When enabled, load from root and all subdirectories with .roo folders
	const directories = await getAgentsDirectoriesForCwd(cwd)

	for (const directory of directories) {
		// Show path for all directories except the root
		const showPath = directory !== cwd
		const content = await loadAgentRulesFileFromDirectory(directory, showPath, cwd)
		if (content && content.trim()) {
			agentRules.push(content.trim())
		}
	}

	return agentRules.join("\n\n")
}

/**
 * Return the concrete agent-instruction files that contribute to the effective
 * task instructions. The context-inheritance manifest stores only these refs
 * and content digests; a managed child's exact aggregate body is persisted in
 * its private instruction snapshot and replayed through the system layer.
 */
export async function loadApplicableAgentInstructionSources(
	cwd: string,
	enableSubfolderRules: boolean = false,
): Promise<Array<{ kind: "agents"; ref: string; text: string }>> {
	const directories = enableSubfolderRules ? await getAgentsDirectoriesForCwd(cwd) : [cwd]
	const sources: Array<{ kind: "agents"; ref: string; text: string }> = []

	for (const directory of directories) {
		for (const filename of ["AGENTS.md", "AGENT.md"]) {
			const ref = path.join(directory, filename)
			const text = await readAgentRulesFile(ref, cwd)
			if (!text) continue
			sources.push({ kind: "agents", ref, text })
			break
		}

		const localRef = path.join(directory, "AGENTS.local.md")
		const localText = await readAgentRulesFile(localRef, cwd)
		if (localText) sources.push({ kind: "agents", ref: localRef, text: localText })
	}

	return sources
}

function formatApplicableAgentInstructionSources(
	cwd: string,
	sources: readonly { kind: "agents"; ref: string; text: string }[],
): string {
	return sources
		.map(({ ref, text }) => {
			const filename = path.basename(ref)
			const directory = path.dirname(ref)
			const showPath = path.resolve(directory) !== path.resolve(cwd)
			const label = filename === "AGENTS.local.md" ? "Local" : "Standard"
			const location = showPath ? ` from ${path.relative(cwd, directory)}` : ""
			return `# Agent Rules ${label} (${filename})${location}:\n${text}`
		})
		.join("\n\n")
}

export async function addCustomInstructions(
	modeCustomInstructions: string,
	globalCustomInstructions: string,
	cwd: string,
	mode: string,
	options: {
		language?: string
		rooIgnoreInstructions?: string
		settings?: SystemPromptSettings
		/** Already captured sources avoid rereading mutable AGENTS files at a child-launch boundary. */
		agentInstructionSources?: readonly { kind: "agents"; ref: string; text: string }[]
	} = {},
): Promise<string> {
	const sections = []

	// Get the enableSubfolderRules setting (default: false)
	const enableSubfolderRules = options.settings?.enableSubfolderRules ?? false

	// Load mode-specific rules if mode is provided
	let modeRuleContent = ""
	let usedRuleFile = ""

	if (mode) {
		const modeRules: string[] = []
		// Use recursive discovery only if enableSubfolderRules is true
		const alphaDirectories = await getRuleDirectoriesForCwd(cwd, enableSubfolderRules)
		const legacyDirectories = enableSubfolderRules
			? await getAllRooDirectoriesForCwd(cwd)
			: [getGlobalRooDirectory(), path.join(cwd, ".roo")]

		// Check for .alpha/rules-${mode}/ directories in order (global, project-local, and optionally subfolders)
		for (const alphaDir of alphaDirectories) {
			const modeRulesDir = path.join(alphaDir, `rules-${mode}`)
			if (await directoryExists(modeRulesDir)) {
				const files = await readTextFilesFromDirectory(modeRulesDir, getRuleTrustRoot(cwd, alphaDir))
				if (files.length > 0) {
					const content = formatDirectoryContent(files, cwd)
					modeRules.push(content)
				}
			}
		}

		// If we found mode-specific rules in .alpha/rules-${mode}/ directories, use them
		if (modeRules.length > 0) {
			modeRuleContent = "\n" + modeRules.join("\n\n")
			usedRuleFile = `rules-${mode} directories`
		} else {
			for (const legacyDir of legacyDirectories) {
				const modeRulesDir = path.join(legacyDir, `rules-${mode}`)
				if (await directoryExists(modeRulesDir)) {
					const files = await readTextFilesFromDirectory(modeRulesDir, getRuleTrustRoot(cwd, legacyDir))
					if (files.length > 0) {
						modeRules.push(formatDirectoryContent(files, cwd))
					}
				}
			}
		}

		if (!modeRuleContent && modeRules.length > 0) {
			modeRuleContent = "\n" + modeRules.join("\n\n")
			usedRuleFile = `legacy rules-${mode} directories`
		} else if (!modeRuleContent) {
			// Fall back to existing behavior for legacy files
			const rooModeRuleFile = `.alpharules-${mode}`
			modeRuleContent = await safeReadFileWithinRoot(path.join(cwd, rooModeRuleFile), cwd)
			if (modeRuleContent) {
				usedRuleFile = rooModeRuleFile
			} else {
				const clineModeRuleFile = `.clinerules-${mode}`
				modeRuleContent = await safeReadFileWithinRoot(path.join(cwd, clineModeRuleFile), cwd)
				if (modeRuleContent) {
					usedRuleFile = clineModeRuleFile
				}
			}
		}
	}

	// Add language preference if provided
	if (options.language) {
		const languageName = isLanguage(options.language) ? LANGUAGES[options.language] : options.language
		sections.push(
			`Language Preference:\nYou should always speak and think in the "${languageName}" (${options.language}) language unless the user gives you instructions below to do otherwise.`,
		)
	}

	// Add global instructions first
	if (typeof globalCustomInstructions === "string" && globalCustomInstructions.trim()) {
		sections.push(`Global Instructions:\n${globalCustomInstructions.trim()}`)
	}

	// Add mode-specific instructions after
	if (typeof modeCustomInstructions === "string" && modeCustomInstructions.trim()) {
		sections.push(`Mode-specific Instructions:\n${modeCustomInstructions.trim()}`)
	}

	// Add rules - include both mode-specific and generic rules if they exist
	const rules = []

	// Add mode-specific rules first if they exist
	if (modeRuleContent && modeRuleContent.trim()) {
		if (usedRuleFile.includes(path.join(".roo", `rules-${mode}`))) {
			rules.push(modeRuleContent.trim())
		} else {
			rules.push(`# Rules from ${usedRuleFile}:\n${modeRuleContent}`)
		}
	}

	if (options.rooIgnoreInstructions) {
		rules.push(options.rooIgnoreInstructions)
	}

	// Add AGENTS.md content if enabled (default: true)
	// Load from root and optionally subdirectories with .roo folders based on enableSubfolderRules setting
	if (options.settings?.useAgentRules !== false) {
		const agentRulesContent =
			options.agentInstructionSources !== undefined
				? formatApplicableAgentInstructionSources(cwd, options.agentInstructionSources)
				: await loadAllAgentRulesFiles(cwd, enableSubfolderRules)
		if (agentRulesContent && agentRulesContent.trim()) {
			rules.push(agentRulesContent.trim())
		}
	}

	// Add generic rules
	const genericRuleContent = await loadRuleFiles(cwd, enableSubfolderRules)
	if (genericRuleContent && genericRuleContent.trim()) {
		rules.push(genericRuleContent.trim())
	}

	if (rules.length > 0) {
		sections.push(`Rules:\n\n${rules.join("\n\n")}`)
	}

	const joinedSections = sections.join("\n\n")

	return joinedSections
		? `
====

USER'S CUSTOM INSTRUCTIONS

The following additional instructions are provided by the user, and should be followed to the best of your ability.

${joinedSections}
`
		: ""
}

/**
 * Check if a file should be included in rule compilation.
 * Excludes cache files and system files that shouldn't be processed as rules.
 */
function shouldIncludeRuleFile(filename: string): boolean {
	const basename = path.basename(filename)

	const cachePatterns = [
		"*.DS_Store",
		"*.bak",
		"*.cache",
		"*.crdownload",
		"*.db",
		"*.dmp",
		"*.dump",
		"*.eslintcache",
		"*.lock",
		"*.log",
		"*.old",
		"*.part",
		"*.partial",
		"*.pyc",
		"*.pyo",
		"*.stackdump",
		"*.swo",
		"*.swp",
		"*.temp",
		"*.tmp",
		"Thumbs.db",
	]

	return !cachePatterns.some((pattern) => {
		if (pattern.startsWith("*.")) {
			const extension = pattern.slice(1)
			return basename.endsWith(extension)
		} else {
			return basename === pattern
		}
	})
}
