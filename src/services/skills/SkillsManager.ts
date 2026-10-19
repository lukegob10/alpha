import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import * as vscode from "vscode"
import matter from "gray-matter"

import type { AlphaProvider } from "../../core/webview/AlphaProvider"
import {
	getGlobalAgentsDirectory,
	getProjectAgentsDirectoryForCwd,
	getProjectInstructionDirectoriesForCwd,
	type ProjectInstructionDiscoveryOptions,
} from "../config-paths"
import { directoryExists, fileExists } from "../config-paths"
import { captureProjectInstructionDiscoveryOptions } from "../config-paths/project-instruction-settings"
import { SkillMetadata, SkillContent, SkillSource } from "../../shared/skills"
import { modes, getAllModes } from "../../shared/modes"
import {
	validateSkillName as validateSkillNameShared,
	SkillNameValidationError,
	SKILL_NAME_MAX_LENGTH,
} from "@alpha-code/types"
import { t } from "../../i18n"
import { readSkillInvocationPolicy } from "./skillPolicy"
import { SkillSelectionError } from "./SkillSelectionError"

// Re-export for convenience
export type { SkillMetadata, SkillContent, SkillSource }

const ALPHA_CONFIG_DIR = ".alpha"
const MAX_PORTABLE_SKILL_DEPTH = 6
const MAX_PORTABLE_SKILL_DIRECTORIES = 2_000
const MAX_PORTABLE_SKILL_ENTRIES = 20_000

type SkillSelection = Partial<Pick<SkillMetadata, "path" | "modeSlugs" | "mode">>

export interface SkillsManagerOptions {
	/** Only the foreground manager may publish the Settings skill catalog. */
	notifyWebview?: boolean
	/** One user-owned boundary shared by this catalog and its task's project instructions. */
	projectInstructionDiscovery?: ProjectInstructionDiscoveryOptions
}

function getGlobalAlphaDirectory(): string {
	return path.join(os.homedir(), ALPHA_CONFIG_DIR)
}

function getProjectAlphaDirectoryForCwd(cwd: string): string {
	return path.join(cwd, ALPHA_CONFIG_DIR)
}

export class SkillsManager {
	private skills: Map<string, SkillMetadata> = new Map()
	private skillsByPath: Map<string, SkillMetadata> = new Map()
	private providerRef: WeakRef<AlphaProvider>
	private disposables: vscode.Disposable[] = []
	private isDisposed = false
	private discoveryGeneration = 0
	private watcherRefresh: Promise<void> | undefined
	private watcherRefreshRequested = false
	private readonly notifyWebview: boolean
	private readonly projectInstructionDiscovery: ProjectInstructionDiscoveryOptions

	constructor(
		provider: AlphaProvider,
		private readonly workspacePath?: string,
		options: SkillsManagerOptions = {},
	) {
		this.providerRef = new WeakRef(provider)
		this.notifyWebview = options.notifyWebview ?? true
		const discovery =
			options.projectInstructionDiscovery ??
			(typeof vscode.workspace.getConfiguration === "function" ? captureProjectInstructionDiscoveryOptions() : {})
		this.projectInstructionDiscovery = Object.freeze({
			...(discovery.projectRootMarkers === undefined
				? {}
				: { projectRootMarkers: Object.freeze([...discovery.projectRootMarkers]) }),
			...(discovery.projectDocFallbackFilenames === undefined
				? {}
				: {
						projectDocFallbackFilenames: Object.freeze([...discovery.projectDocFallbackFilenames]),
					}),
		})
	}

	async initialize(): Promise<void> {
		await this.discoverSkills()
		await this.setupFileWatchers()
	}

	getProjectInstructionDiscoveryOptions(): ProjectInstructionDiscoveryOptions {
		return this.projectInstructionDiscovery
	}

	/**
	 * Discover all skills from global and project directories.
	 * Supports both generic skills (skills/) and mode-specific skills (skills-{mode}/).
	 * Also supports symlinks:
	 * - .alpha/skills can be a symlink to a directory containing skill subdirectories
	 * - .alpha/skills/[dirname] can be a symlink to a skill directory
	 */
	async discoverSkills(): Promise<void> {
		if (this.isDisposed) return
		const generation = ++this.discoveryGeneration
		const discovered = new Map<string, SkillMetadata>()
		const discoveredByPath = new Map<string, SkillMetadata>()
		const skillsDirs = await this.getSkillsDirectories()

		for (const { dir, source, mode, recursive } of skillsDirs) {
			if (this.isDisposed || generation !== this.discoveryGeneration) return
			await this.scanSkillsDirectory(dir, source, discovered, discoveredByPath, mode, recursive, generation)
		}
		// Readers see complete catalogs; an older refresh cannot overwrite a newer one.
		if (!this.isDisposed && generation === this.discoveryGeneration) {
			this.skills = discovered
			this.skillsByPath = discoveredByPath
		}
	}

	async refreshSkills(): Promise<SkillMetadata[]> {
		await this.discoverSkills()
		return this.getSkillsMetadata()
	}

	private refreshSkillsAndNotify(): Promise<void> {
		if (this.isDisposed) return Promise.resolve()
		this.watcherRefreshRequested = true
		// Changes during a scan invalidate it; only a complete, current catalog may be published.
		this.discoveryGeneration++
		if (!this.watcherRefresh) {
			// Overlapping watcher patterns share one scan, including events delivered in the same turn.
			this.watcherRefresh = Promise.resolve().then(async () => {
				try {
					while (this.watcherRefreshRequested && !this.isDisposed) {
						this.watcherRefreshRequested = false
						try {
							const skills = await this.refreshSkills()
							if (this.notifyWebview && !this.isDisposed && !this.watcherRefreshRequested) {
								await this.providerRef.deref()?.postMessageToWebview({ type: "skills", skills })
							}
						} catch (error) {
							// A newer event still requires a scan even if obsolete discovery or publication failed.
							if (this.watcherRefreshRequested && !this.isDisposed) continue
							throw error
						}
					}
				} finally {
					this.watcherRefresh = undefined
				}
			})
		}
		return this.watcherRefresh
	}

	/**
	 * Scan portable roots recursively; keep Alpha and bundled layout compatibility.
	 * Handles two symlink cases:
	 * 1. The skills directory itself is a symlink (resolved by directoryExists using realpath)
	 * 2. Individual skill subdirectories are symlinks
	 */
	private async scanSkillsDirectory(
		dirPath: string,
		source: SkillSource,
		discovered: Map<string, SkillMetadata>,
		discoveredByPath: Map<string, SkillMetadata>,
		mode?: string,
		recursive: boolean = false,
		generation: number = this.discoveryGeneration,
	): Promise<void> {
		if (!(await directoryExists(dirPath))) {
			return
		}

		try {
			// Get the real path (resolves if dirPath is a symlink)
			const realDirPath = await fs.realpath(dirPath)

			const queue = [{ directory: realDirPath, depth: 0 }]
			const visited = new Set<string>([this.normalizeSkillPath(realDirPath)])
			let scannedEntries = 0
			const reportLimit = () => console.warn(`Skills scan reached its traversal limit (root: ${dirPath})`)
			for (let index = 0; index < queue.length; index++) {
				if (this.isDisposed || generation !== this.discoveryGeneration) return
				const { directory, depth } = queue[index]!
				const entries = await fs.readdir(directory).catch(() => [])
				// Sorting makes duplicate-name resolution and bounded truncation reproducible.
				entries.sort()
				for (const entryName of entries) {
					if (this.isDisposed || generation !== this.discoveryGeneration) return
					if (recursive && ++scannedEntries > MAX_PORTABLE_SKILL_ENTRIES) {
						reportLimit()
						return
					}
					if (recursive && entryName.startsWith(".")) continue
					const entryPath = path.join(directory, entryName)
					const stats = await fs.stat(entryPath).catch(() => null)
					if (!stats?.isDirectory()) continue

					// Resolve aliases only for the visited set; selected paths retain their discovery identity.
					if (recursive) {
						const realEntryPath = await fs.realpath(entryPath).catch(() => undefined)
						if (!realEntryPath) continue
						const identity = this.normalizeSkillPath(realEntryPath)
						if (visited.has(identity)) continue
						if (visited.size >= MAX_PORTABLE_SKILL_DIRECTORIES) {
							reportLimit()
							return
						}
						visited.add(identity)
					}
					await this.loadSkillMetadata(entryPath, source, discovered, discoveredByPath, mode, entryName)
					if (recursive && depth + 2 < MAX_PORTABLE_SKILL_DEPTH) {
						queue.push({ directory: entryPath, depth: depth + 1 })
					}
				}
			}
		} catch {
			// Directory doesn't exist or can't be read - this is fine
		}
	}

	/**
	 * Load skill metadata from a skill directory.
	 * @param skillDir - The resolved path to the skill directory (target of symlink if symlinked)
	 * @param source - Whether this is a global or project skill
	 * @param mode - The mode this skill is specific to (undefined for generic skills)
	 * @param skillName - The skill name (from symlink name if symlinked, otherwise from directory name)
	 */
	private async loadSkillMetadata(
		skillDir: string,
		source: SkillSource,
		discovered: Map<string, SkillMetadata>,
		discoveredByPath: Map<string, SkillMetadata>,
		mode?: string,
		skillName?: string,
	): Promise<void> {
		const skillMdPath = path.join(skillDir, "SKILL.md")
		if (!(await fileExists(skillMdPath))) return

		try {
			const fileContent = await fs.readFile(skillMdPath, "utf-8")

			// Use gray-matter to parse frontmatter
			const { data: frontmatter, content: body } = matter(fileContent)

			// Validate required fields (only name and description for now)
			if (!frontmatter.name || typeof frontmatter.name !== "string") {
				console.error(`Skill at ${skillDir} is missing required 'name' field`)
				return
			}
			if (!frontmatter.description || typeof frontmatter.description !== "string") {
				console.error(`Skill at ${skillDir} is missing required 'description' field`)
				return
			}

			// Validate that frontmatter name matches the skill name (directory name or symlink name)
			// Per the Agent Skills spec: "name field must match the parent directory name"
			const effectiveSkillName = skillName || path.basename(skillDir)
			if (frontmatter.name !== effectiveSkillName) {
				console.error(`Skill name "${frontmatter.name}" doesn't match directory "${effectiveSkillName}"`)
				return
			}

			// Validate skill name per agentskills.io spec using shared validation
			const nameValidation = validateSkillNameShared(effectiveSkillName)
			if (!nameValidation.valid) {
				const errorMessage = this.getSkillNameErrorMessage(effectiveSkillName, nameValidation.error!)
				console.error(`Skill name "${effectiveSkillName}" is invalid: ${errorMessage}`)
				return
			}

			// Description constraints:
			// - 1-1024 chars
			// - non-empty (after trimming)
			const description = frontmatter.description.trim()
			if (description.length < 1 || description.length > 1024) {
				console.error(
					`Skill "${effectiveSkillName}" has an invalid description length: must be 1-1024 characters (got ${description.length})`,
				)
				return
			}

			// Parse modeSlugs from frontmatter (new format) or fall back to directory-based mode
			// Priority: frontmatter.modeSlugs > frontmatter.mode > directory mode
			let modeSlugs: string[] | undefined
			if (Array.isArray(frontmatter.modeSlugs)) {
				modeSlugs = frontmatter.modeSlugs.filter((s: unknown) => typeof s === "string" && s.length > 0)
				if (modeSlugs.length === 0) {
					modeSlugs = undefined // Empty array means "any mode"
				}
			} else if (typeof frontmatter.mode === "string" && frontmatter.mode.length > 0) {
				// Legacy single mode in frontmatter
				modeSlugs = [frontmatter.mode]
			} else if (mode) {
				// Fall back to directory-based mode (skills-{mode}/)
				modeSlugs = [mode]
			}

			// Create unique key combining name, source, and modeSlugs for override resolution
			// For backward compatibility, use first mode slug or undefined for the key
			const primaryMode = modeSlugs?.[0]
			const skillKey = this.getSkillKey(effectiveSkillName, source, primaryMode)
			const allowImplicitInvocation = await readSkillInvocationPolicy(skillDir)

			const skill: SkillMetadata = {
				name: effectiveSkillName,
				description,
				path: skillMdPath,
				source,
				mode: primaryMode, // Deprecated: kept for backward compatibility
				modeSlugs, // New: array of mode slugs, undefined = any mode
				...(allowImplicitInvocation === undefined ? {} : { allowImplicitInvocation }),
			}
			discovered.set(skillKey, skill)
			// Override resolution changes the visible catalog, but a child may have captured
			// an earlier path that is still discovered. Keep only this refresh's identities.
			discoveredByPath.set(this.normalizeSkillPath(skillMdPath), skill)
		} catch (error) {
			console.error(`Failed to load skill at ${skillDir}:`, error)
		}
	}

	/**
	 * Get skills available for the current mode.
	 * Resolves overrides: project > global, mode-specific > generic.
	 *
	 * @param currentMode - The current mode slug (e.g., 'code', 'architect')
	 */
	getSkillsForMode(currentMode: string): SkillMetadata[] {
		const resolvedSkills = new Map<string, SkillMetadata>()

		for (const skill of this.skills.values()) {
			if (!this.isSkillEnabled(skill)) continue
			// Check if skill is available in current mode:
			// - modeSlugs undefined or empty = available in all modes ("Any mode")
			// - modeSlugs array with values = available only if currentMode is in the array
			const isAvailableInMode = this.isSkillAvailableInMode(skill, currentMode)
			if (!isAvailableInMode) continue

			const existingSkill = resolvedSkills.get(skill.name)

			if (!existingSkill) {
				resolvedSkills.set(skill.name, skill)
				continue
			}

			// Apply override rules
			const shouldOverride = this.shouldOverrideSkill(existingSkill, skill)
			if (shouldOverride) {
				resolvedSkills.set(skill.name, skill)
			}
		}

		return Array.from(resolvedSkills.values())
	}

	/** Filter only after override resolution so an explicit-only override cannot reveal its ancestor. */
	getImplicitSkillsForMode(currentMode: string): SkillMetadata[] {
		return this.getSkillsForMode(currentMode).filter((skill) => skill.allowImplicitInvocation !== false)
	}

	/**
	 * Check if a skill is available in the given mode.
	 * - modeSlugs undefined or empty = available in all modes ("Any mode")
	 * - modeSlugs with values = available only if mode is in the array
	 */
	private isSkillAvailableInMode(skill: SkillMetadata, currentMode: string): boolean {
		// No mode restrictions = available in all modes
		if (!skill.modeSlugs || skill.modeSlugs.length === 0) {
			return true
		}
		// Check if current mode is in the allowed modes
		return skill.modeSlugs.includes(currentMode)
	}

	/**
	 * Determine if newSkill should override existingSkill based on priority rules.
	 * Priority: project > global, mode-specific > generic
	 */
	private shouldOverrideSkill(existing: SkillMetadata, newSkill: SkillMetadata): boolean {
		// Define source priority: project > global
		const sourcePriority: Record<string, number> = {
			builtin: 0,
			project: 2,
			global: 1,
		}

		const existingPriority = sourcePriority[existing.source] ?? 0
		const newPriority = sourcePriority[newSkill.source] ?? 0

		// Higher priority source always wins
		if (newPriority > existingPriority) return true
		if (newPriority < existingPriority) return false

		// Same source: mode-specific overrides generic
		// A skill with modeSlugs (restricted) is more specific than one without (any mode)
		const existingHasModes = existing.modeSlugs && existing.modeSlugs.length > 0
		const newHasModes = newSkill.modeSlugs && newSkill.modeSlugs.length > 0
		if (newHasModes && !existingHasModes) return true
		if (!newHasModes && existingHasModes) return false

		// Same source and same mode-specificity: keep existing (first wins)
		return false
	}

	private isSkillEnabled(skill: SkillMetadata): boolean {
		return (
			skill.source !== "builtin" ||
			!this.providerRef.deref()?.contextProxy?.getValue("disabledBuiltinSkills")?.includes(skill.name)
		)
	}

	private assertWritableSource(source: SkillSource): void {
		if (source !== "global" && source !== "project") {
			throw new Error(t("skills:errors.builtin_read_only"))
		}
	}

	async assertSkillEditable(skill: SkillMetadata): Promise<void> {
		this.assertWritableSource(skill.source)
		await this.assertWritablePath(skill.path)
	}

	/** Resolve existing symlinks even when the final destination has not been created yet. */
	private async resolveMutationPath(candidate: string): Promise<string> {
		try {
			return await fs.realpath(candidate)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
			const parent = path.dirname(candidate)
			if (parent === candidate) throw error
			return path.join(await this.resolveMutationPath(parent), path.basename(candidate))
		}
	}

	private async assertWritablePath(candidate: string): Promise<void> {
		const extensionPath = this.providerRef.deref()?.contextProxy?.extensionUri?.fsPath
		if (!extensionPath) return
		const bundledRoot = path.join(extensionPath, "assets", "skills")
		const contains = (directory: string, target: string) => {
			const relative = path.relative(directory, target)
			return (
				relative === "" ||
				(!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
			)
		}
		const resolvedCandidate = await this.resolveMutationPath(path.resolve(candidate))
		const resolvedRoot = await this.resolveMutationPath(path.resolve(bundledRoot))
		// Also protect parents from recursive deletion/moves and aliases of the installed root.
		if (contains(resolvedRoot, resolvedCandidate) || contains(resolvedCandidate, resolvedRoot)) {
			throw new Error(t("skills:errors.builtin_read_only"))
		}
	}

	/**
	 * Get all skills (for UI display, debugging, etc.)
	 */
	getAllSkills(): SkillMetadata[] {
		return Array.from(this.skills.values())
	}

	async getSkillContent(name: string, currentMode?: string): Promise<SkillContent | null> {
		// If mode is provided, try to find the best matching skill
		let skill: SkillMetadata | undefined

		if (currentMode) {
			const modeSkills = this.getSkillsForMode(currentMode)
			skill = modeSkills.find((s) => s.name === name)
		} else {
			// Fall back to any skill with this name
			skill = Array.from(this.skills.values())
				.filter((s) => s.name === name && this.isSkillEnabled(s))
				.reduce<SkillMetadata | undefined>(
					(selected, candidate) =>
						!selected || this.shouldOverrideSkill(selected, candidate) ? candidate : selected,
					undefined,
				)
		}

		if (!skill) return null

		// Read skill content from disk
		const fileContent = await fs.readFile(skill.path, "utf-8")
		const { content: body } = matter(fileContent)

		return {
			...skill,
			instructions: body.trim(),
		}
	}

	/** Explicit selection retains normal overrides while checking path selectors against the live task catalog. */
	async getExplicitSkillContent(selector: string, currentMode?: string): Promise<SkillContent | null> {
		const assertAvailable = (skill: SkillMetadata) => {
			if (!this.isSkillEnabled(skill)) throw new SkillSelectionError(t("skills:errors.explicit_disabled"))
			if (currentMode !== undefined && !this.isSkillAvailableInMode(skill, currentMode)) {
				throw new SkillSelectionError(t("skills:errors.explicit_mode_unavailable"))
			}
		}
		// A path selects only an already discovered identity. Never read an arbitrary user-supplied path.
		if (path.isAbsolute(selector)) {
			const skill = this.skillsByPath.get(this.normalizeSkillPath(selector))
			if (!skill) return null
			assertAvailable(skill)
			return this.getSkillContentByPath(skill.name, skill.path)
		}

		const qualified = /^(global|project|builtin):(.+)$/.exec(selector)
		if (!qualified) {
			if (selector.includes(":")) return null
			const selected = Array.from(this.skills.values())
				.filter(
					(skill) =>
						skill.name === selector &&
						this.isSkillEnabled(skill) &&
						(currentMode === undefined || this.isSkillAvailableInMode(skill, currentMode)),
				)
				.reduce<SkillMetadata | undefined>(
					(previous, candidate) =>
						!previous || this.shouldOverrideSkill(previous, candidate) ? candidate : previous,
					undefined,
				)
			if (selected) return this.getExplicitSkillContent(`${selected.source}:${selector}`, currentMode)
			const unavailable = Array.from(this.skills.values()).find((skill) => skill.name === selector)
			if (unavailable) assertAvailable(unavailable)
			return null
		}
		const [, source, name] = qualified
		let candidates = Array.from(this.skills.values()).filter(
			(skill) =>
				skill.source === source &&
				skill.name === name &&
				this.isSkillEnabled(skill) &&
				(currentMode === undefined || this.isSkillAvailableInMode(skill, currentMode)),
		)
		// Retain the existing mode-specific-over-generic precedence within the selected source.
		if (candidates.some((skill) => skill.modeSlugs?.length)) {
			candidates = candidates.filter((skill) => skill.modeSlugs?.length)
		}
		if (candidates.length > 1) {
			throw new SkillSelectionError(t("skills:errors.explicit_ambiguous"))
		}
		const skill = candidates[0]
		if (!skill) {
			const unavailable = Array.from(this.skills.values()).find(
				(entry) => entry.source === source && entry.name === name,
			)
			if (unavailable) assertAvailable(unavailable)
		}
		return skill ? this.getSkillContentByPath(skill.name, skill.path) : null
	}

	/** Resolve a previously captured skill by its exact path, independent of mutable mode overrides. */
	async getSkillContentByPath(name: string, capturedPath: string): Promise<SkillContent | null> {
		const skill = this.skillsByPath.get(this.normalizeSkillPath(capturedPath))
		if (!skill || skill.name !== name) return null

		const fileContent = await fs.readFile(skill.path, "utf-8")
		const { content: body } = matter(fileContent)
		return { ...skill, instructions: body.trim() }
	}

	private normalizeSkillPath(candidate: string): string {
		const resolved = path.resolve(candidate)
		return process.platform === "win32" ? resolved.toLowerCase() : resolved
	}

	/**
	 * Get all skills metadata (for UI display)
	 * Returns skills from all sources without content
	 */
	getSkillsMetadata(): SkillMetadata[] {
		return this.getAllSkills()
	}

	/**
	 * Get a skill by name, source, and optionally mode
	 */
	getSkill(name: string, source: SkillSource, mode?: string): SkillMetadata | undefined {
		const skillKey = this.getSkillKey(name, source, mode)
		return this.skills.get(skillKey)
	}

	/**
	 * Resolve a Settings selection against this manager's complete discovery catalog.
	 * Paths retain identity across mode edits and overrides; legacy selectors must be unambiguous.
	 */
	findSkillByNameAndSource(
		name: string,
		source: SkillSource,
		selection: SkillSelection = {},
	): SkillMetadata | undefined {
		if (selection.path !== undefined) {
			if (typeof selection.path !== "string" || !path.isAbsolute(selection.path)) return undefined
			const skill = this.skillsByPath.get(this.normalizeSkillPath(selection.path))
			return skill?.name === name && skill.source === source ? skill : undefined
		}

		let candidates = Array.from(this.skillsByPath.values()).filter(
			(skill) => skill.name === name && skill.source === source,
		)
		if (selection.modeSlugs !== undefined) {
			if (
				!Array.isArray(selection.modeSlugs) ||
				!selection.modeSlugs.every((slug) => typeof slug === "string" && slug.length > 0)
			) {
				return undefined
			}
			const selectedModes = new Set(selection.modeSlugs)
			candidates = candidates.filter((skill) => {
				const skillModes = new Set(skill.modeSlugs ?? [])
				return (
					skillModes.size === selectedModes.size && [...selectedModes].every((slug) => skillModes.has(slug))
				)
			})
		} else if (selection.mode !== undefined) {
			// Legacy single-mode requests identified the primary mode, including multi-mode skills.
			candidates = candidates.filter((skill) => skill.mode === selection.mode)
		}
		if (candidates.length > 1) throw new Error(t("skills:errors.ambiguous_skill", { name }))
		return candidates[0]
	}

	/**
	 * Validate skill name per agentskills.io spec using shared validation.
	 * Converts error codes to user-friendly error messages.
	 */
	private validateSkillName(name: string): { valid: boolean; error?: string } {
		const result = validateSkillNameShared(name)
		if (!result.valid) {
			return { valid: false, error: this.getSkillNameErrorMessage(name, result.error!) }
		}
		return { valid: true }
	}

	/**
	 * Convert skill name validation error code to a user-friendly error message.
	 */
	private getSkillNameErrorMessage(name: string, error: SkillNameValidationError): string {
		switch (error) {
			case SkillNameValidationError.Empty:
				return t("skills:errors.name_length", { maxLength: SKILL_NAME_MAX_LENGTH, length: name.length })
			case SkillNameValidationError.TooLong:
				return t("skills:errors.name_length", { maxLength: SKILL_NAME_MAX_LENGTH, length: name.length })
			case SkillNameValidationError.InvalidFormat:
				return t("skills:errors.name_format")
		}
	}

	/**
	 * Create a new skill
	 * @param name - Skill name (must be valid per agentskills.io spec)
	 * @param source - "global" or "project"
	 * @param description - Skill description
	 * @param modeSlugs - Optional mode restrictions (undefined/empty = any mode)
	 * @returns Path to created SKILL.md file
	 */
	async createSkill(name: string, source: SkillSource, description: string, modeSlugs?: string[]): Promise<string> {
		this.assertWritableSource(source)
		// Validate skill name
		const validation = this.validateSkillName(name)
		if (!validation.valid) {
			throw new Error(validation.error)
		}

		// Validate description
		const trimmedDescription = description.trim()
		if (trimmedDescription.length < 1 || trimmedDescription.length > 1024) {
			throw new Error(t("skills:errors.description_length", { length: trimmedDescription.length }))
		}

		// Determine base directory
		let baseDir: string
		if (source === "global") {
			baseDir = getGlobalAgentsDirectory()
		} else {
			const provider = this.providerRef.deref()
			if (!provider?.cwd) {
				throw new Error(t("skills:errors.no_workspace"))
			}
			baseDir = getProjectAgentsDirectoryForCwd(provider.cwd)
		}

		// New skills use the portable .agents convention; mode info remains in frontmatter.
		const skillsDir = path.join(baseDir, "skills")
		const skillDir = path.join(skillsDir, name)
		const skillMdPath = path.join(skillDir, "SKILL.md")

		// Check if skill already exists
		await this.assertWritablePath(skillMdPath)
		if (await fileExists(skillMdPath)) {
			throw new Error(t("skills:errors.already_exists", { name, path: skillMdPath }))
		}

		// Create the skill directory
		await fs.mkdir(skillDir, { recursive: true })

		// Generate SKILL.md content with frontmatter
		const titleName = name
			.split("-")
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" ")

		// Serialize user text as YAML data, preserving punctuation and multiline descriptions.
		const skillContent = matter.stringify(
			`\n# ${titleName}

## Instructions

Add your skill instructions here.
`,
			{
				name,
				description: trimmedDescription,
				...(modeSlugs?.length ? { modeSlugs } : {}),
			},
		)

		// Write the SKILL.md file
		await fs.writeFile(skillMdPath, skillContent, "utf-8")

		// Refresh skills list
		await this.discoverSkills()

		return skillMdPath
	}

	/**
	 * Delete a skill
	 * @param name - Skill name to delete
	 * @param source - Where the skill is located
	 * @param mode - Optional mode (to locate in skills-{mode}/ directory)
	 */
	async deleteSkill(name: string, source: SkillSource, mode?: string, selection: SkillSelection = {}): Promise<void> {
		this.assertWritableSource(source)
		// Find the skill
		const skill = this.findSkillByNameAndSource(name, source, { mode, ...selection })
		if (!skill) {
			const modeInfo = mode ? ` (mode: ${mode})` : ""
			throw new Error(t("skills:errors.not_found", { name, source, modeInfo }))
		}

		// Get the skill directory (parent of SKILL.md)
		const skillDir = path.dirname(skill.path)

		// Delete the entire skill directory
		await this.assertWritablePath(skill.path)
		await this.assertWritablePath(skillDir)
		await fs.rm(skillDir, { recursive: true, force: true })

		// Refresh skills list
		await this.discoverSkills()
	}

	/**
	 * Move a skill to a different mode
	 * @param name - Skill name to move
	 * @param source - Where the skill is located ("global" or "project")
	 * @param currentMode - Current mode (undefined for generic skills)
	 * @param newMode - Target mode (undefined for generic skills)
	 */
	async moveSkill(
		name: string,
		source: SkillSource,
		currentMode: string | undefined,
		newMode: string | undefined,
	): Promise<void> {
		this.assertWritableSource(source)
		// Don't move if source and destination are the same
		if (currentMode === newMode) {
			return
		}

		// Find the skill at its current location
		const skill = this.getSkill(name, source, currentMode)
		if (!skill) {
			const modeInfo = currentMode ? ` (mode: ${currentMode})` : ""
			throw new Error(t("skills:errors.not_found", { name, source, modeInfo }))
		}

		// Determine base directory
		let baseDir: string
		if (source === "global") {
			baseDir = getGlobalAlphaDirectory()
		} else {
			const provider = this.providerRef.deref()
			if (!provider?.cwd) {
				throw new Error(t("skills:errors.no_workspace"))
			}
			baseDir = getProjectAlphaDirectoryForCwd(provider.cwd)
		}

		// Determine source and destination directories
		const sourceDirName = currentMode ? `skills-${currentMode}` : "skills"
		const destDirName = newMode ? `skills-${newMode}` : "skills"
		const sourceDir = path.join(baseDir, sourceDirName, name)
		const destSkillsDir = path.join(baseDir, destDirName)
		const destDir = path.join(destSkillsDir, name)
		const destSkillMdPath = path.join(destDir, "SKILL.md")

		// Check if skill already exists at destination
		await this.assertWritablePath(skill.path)
		await this.assertWritablePath(sourceDir)
		await this.assertWritablePath(destDir)
		if (await fileExists(destSkillMdPath)) {
			throw new Error(t("skills:errors.already_exists", { name, path: destSkillMdPath }))
		}

		// Ensure destination skills directory exists
		await fs.mkdir(destSkillsDir, { recursive: true })

		// Move the skill directory
		await fs.rename(sourceDir, destDir)

		// Clean up empty source skills directory
		const sourceSkillsDir = path.join(baseDir, sourceDirName)
		try {
			const entries = await fs.readdir(sourceSkillsDir)
			if (entries.length === 0) {
				await fs.rmdir(sourceSkillsDir)
			}
		} catch {
			// Ignore errors - directory might not exist or have permission issues
		}

		// Refresh skills list
		await this.discoverSkills()
	}

	/**
	 * Update the mode associations for a skill by modifying its SKILL.md frontmatter.
	 * @param name - Skill name
	 * @param source - Where the skill is located ("global" or "project")
	 * @param newModeSlugs - New mode slugs (undefined/empty = any mode)
	 */
	async updateSkillModes(
		name: string,
		source: SkillSource,
		newModeSlugs?: string[],
		selection: SkillSelection = {},
	): Promise<void> {
		this.assertWritableSource(source)
		const skill = this.findSkillByNameAndSource(name, source, selection)

		if (!skill) {
			throw new Error(t("skills:errors.not_found", { name, source, modeInfo: "" }))
		}

		await this.assertWritablePath(skill.path)
		// Read the current SKILL.md file
		const fileContent = await fs.readFile(skill.path, "utf-8")
		const { data: frontmatter, content: body } = matter(fileContent)

		// An explicit empty array overrides skills-{mode}/ defaults during rediscovery.
		frontmatter.modeSlugs = newModeSlugs ?? []
		delete frontmatter.mode

		// Serialize back to SKILL.md format
		const newContent = matter.stringify(body, frontmatter)
		await fs.writeFile(skill.path, newContent, "utf-8")

		// Refresh skills list
		await this.discoverSkills()
	}

	/**
	 * Get all skills directories to scan, including mode-specific directories.
	 */
	private async getSkillsDirectories(): Promise<
		Array<{
			dir: string
			source: SkillSource
			mode?: string
			recursive?: boolean
		}>
	> {
		const dirs: Array<{ dir: string; source: SkillSource; mode?: string; recursive?: boolean }> = []
		const globalAlphaDir = getGlobalAlphaDirectory()
		const globalAgentsDir = getGlobalAgentsDirectory()
		const provider = this.providerRef.deref()
		const extensionPath = provider?.contextProxy?.extensionUri?.fsPath
		if (extensionPath) {
			dirs.push({ dir: path.join(extensionPath, "assets", "skills"), source: "builtin" })
		}
		const cwd = this.workspacePath ?? provider?.cwd
		const projectAlphaDir = cwd ? getProjectAlphaDirectoryForCwd(cwd) : null
		const projectDirectories = cwd
			? (await getProjectInstructionDirectoriesForCwd(cwd, this.projectInstructionDiscovery)).directories
			: []

		// Get list of modes to check for mode-specific skills
		const modesList = await this.getAvailableModes()

		// Priority rules for skills with the same name:
		// 1. Source level: project > global (handled by shouldOverrideSkill in getSkillsForMode)
		// 2. Within the same source level: later-processed directories override earlier ones
		//    (via Map.set replacement during discovery - same source+mode+name key gets replaced)
		//
		// Processing order (later directories override earlier ones at the same source level):
		// - Global: .agents/skills first, then .alpha/skills (so Alpha-specific skills win)
		// - Project: .agents/skills from the project root through cwd, then cwd's .alpha/skills.
		//   This retains Alpha-specific overrides; a nearer portable skill overrides its ancestor.

		// Global .agents directories (lowest priority - shared across agents)
		dirs.push({ dir: path.join(globalAgentsDir, "skills"), source: "global", recursive: true })
		for (const mode of modesList) {
			dirs.push({ dir: path.join(globalAgentsDir, `skills-${mode}`), source: "global", mode, recursive: true })
		}

		// Portable skills apply from the nearest repository root through this task's cwd.
		for (const directory of projectDirectories) {
			const projectAgentsDir = getProjectAgentsDirectoryForCwd(directory)
			dirs.push({ dir: path.join(projectAgentsDir, "skills"), source: "project", recursive: true })
			for (const mode of modesList) {
				dirs.push({
					dir: path.join(projectAgentsDir, `skills-${mode}`),
					source: "project",
					mode,
					recursive: true,
				})
			}
		}

		// Global .alpha directories (Alpha-specific, higher priority than .agents)
		dirs.push({ dir: path.join(globalAlphaDir, "skills"), source: "global" })
		for (const mode of modesList) {
			dirs.push({ dir: path.join(globalAlphaDir, `skills-${mode}`), source: "global", mode })
		}

		// Project .alpha directories (highest priority)
		if (projectAlphaDir) {
			dirs.push({ dir: path.join(projectAlphaDir, "skills"), source: "project" })
			for (const mode of modesList) {
				dirs.push({ dir: path.join(projectAlphaDir, `skills-${mode}`), source: "project", mode })
			}
		}

		return dirs
	}

	/**
	 * Get list of available modes (built-in + custom)
	 */
	private async getAvailableModes(): Promise<string[]> {
		const provider = this.providerRef.deref()
		const builtInModeSlugs = modes.map((m) => m.slug)

		if (!provider) {
			return builtInModeSlugs
		}

		try {
			const customModes = await provider.customModesManager.getCustomModes()
			const allModes = getAllModes(customModes)
			return allModes.map((m) => m.slug)
		} catch {
			return builtInModeSlugs
		}
	}

	private getSkillKey(name: string, source: string, mode?: string): string {
		return `${source}:${mode || "generic"}:${name}`
	}

	private async setupFileWatchers(): Promise<void> {
		// Skip if test environment is detected or VSCode APIs are not available
		if (process.env.NODE_ENV === "test" || !vscode.workspace.createFileSystemWatcher) {
			return
		}

		const cwd = this.workspacePath ?? this.providerRef.deref()?.cwd
		if (!cwd) return
		const { directories } = await getProjectInstructionDirectoriesForCwd(cwd, this.projectInstructionDiscovery)
		if (this.isDisposed) return

		this.watchSkillsTree(os.homedir(), ".alpha")
		this.watchSkillsTree(os.homedir(), ".agents")
		this.watchSkillsTree(cwd, ".alpha")
		for (const directory of directories) this.watchSkillsTree(directory, ".agents")
	}

	private watchSkillsTree(basePath: string, configDirName: string): void {
		this.watchPattern(basePath, `${configDirName}/{skills,skills-*}/**/SKILL.md`)
		this.watchPattern(basePath, `${configDirName}/{skills,skills-*}/**/agents/openai.yaml`)
		this.watchPattern(basePath, `${configDirName}/{skills,skills-*}/**/agents`)
		this.watchPattern(basePath, configDirName)
		this.watchPattern(basePath, `${configDirName}/{skills,skills-*}`)
		this.watchPattern(basePath, `${configDirName}/{skills,skills-*}/*`)
	}

	private watchPattern(basePath: string, globPattern: string): void {
		if (process.env.NODE_ENV === "test" || !vscode.workspace.createFileSystemWatcher) {
			return
		}

		const pattern = new vscode.RelativePattern(basePath, globPattern)
		const watcher = vscode.workspace.createFileSystemWatcher(pattern)

		watcher.onDidChange(async (uri) => {
			if (this.isDisposed) return
			await this.refreshSkillsAndNotify()
		})

		watcher.onDidCreate(async (uri) => {
			if (this.isDisposed) return
			await this.refreshSkillsAndNotify()
		})

		watcher.onDidDelete(async (uri) => {
			if (this.isDisposed) return
			await this.refreshSkillsAndNotify()
		})

		this.disposables.push(watcher)
	}

	async dispose(): Promise<void> {
		this.isDisposed = true
		this.watcherRefreshRequested = false
		this.disposables.forEach((d) => d.dispose())
		this.disposables = []
		this.skills.clear()
		this.skillsByPath.clear()
	}
}
