import { execFile } from "child_process"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { promisify } from "util"
import { parse } from "shell-quote"

import { classifyPlanCommand } from "../../shared/plan-command"
import type { ToolUse } from "../../shared/tools"
import { parsePatch } from "../tools/apply-patch/parser"
import { fingerprintContent } from "../tools/contentVersion"

const execFileAsync = promisify(execFile)
const MAX_PATHS = 256
const MAX_PATH_LENGTH = 4_096
const MAX_FILE_BYTES = 4 * 1_024 * 1_024
const MAX_TOTAL_BYTES = 16 * 1_024 * 1_024
const MAX_COMMAND_LENGTH = 4_096
const MAX_MANIFEST_BYTES = 256 * 1_024
const MAX_ANCESTORS = 32
const MAX_GIT_OUTPUT_BYTES = 1_024 * 1_024

export type VerificationContent = Record<string, string>

/** An unknown observation must become verification debt, never an empty change set. */
export class VerificationScopeError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "VerificationScopeError"
	}
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException)?.code === "ENOENT"
}

function containsPath(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate)
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

function resolveContainedPath(root: string, candidate: string): string {
	if (!candidate || candidate.length > MAX_PATH_LENGTH || /[\0\r\n]/.test(candidate)) {
		throw new VerificationScopeError("Invalid verification path")
	}
	const absolute = path.resolve(root, candidate)
	if (!containsPath(root, absolute)) throw new VerificationScopeError("Verification path is outside the workspace")
	return absolute
}

async function realContainedPath(root: string, absolute: string): Promise<string | undefined> {
	try {
		const real = await fs.realpath(absolute)
		if (!containsPath(root, real))
			throw new VerificationScopeError("Verification path resolves outside the workspace")
		return real
	} catch (error) {
		if (!isMissing(error)) throw error
		// A missing leaf is safe only if its nearest existing parent is also contained.
		if (absolute === root) throw error
		await realContainedPath(root, path.dirname(absolute))
		return undefined
	}
}

async function readBoundedFile(root: string, absolute: string, limit: number): Promise<Buffer | undefined> {
	const real = await realContainedPath(root, absolute)
	if (!real) return undefined
	const handle = await fs.open(real, "r")
	try {
		const before = await handle.stat()
		if (!before.isFile() || before.size > limit) {
			throw new VerificationScopeError("Verification content is not a bounded regular file")
		}
		// readFile can allocate past a stat-based bound if another writer grows the file.
		const buffer = Buffer.alloc(before.size + 1)
		let bytesRead = 0
		while (bytesRead < buffer.length) {
			const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
			if (result.bytesRead === 0) break
			bytesRead += result.bytesRead
		}
		const after = await handle.stat()
		const currentReal = await realContainedPath(root, absolute)
		const current = currentReal ? await fs.stat(currentReal) : undefined
		if (
			bytesRead !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs ||
			currentReal !== real ||
			current?.dev !== after.dev ||
			current?.ino !== after.ino ||
			current?.size !== after.size ||
			current?.mtimeMs !== after.mtimeMs
		) {
			throw new VerificationScopeError("Verification content changed while it was being observed")
		}
		return buffer.subarray(0, bytesRead)
	} finally {
		await handle.close()
	}
}

function boundedPaths(paths: readonly string[]): string[] {
	if (paths.length > MAX_PATHS) throw new VerificationScopeError("Verification path count exceeds the bound")
	return [...new Set(paths)].sort()
}

/** Fingerprints bytes (including binary files); missing files have a distinct non-hash marker. */
export async function captureVerificationContent(
	workspaceRoot: string,
	paths: readonly string[],
): Promise<VerificationContent> {
	const root = await fs.realpath(workspaceRoot)
	const content: VerificationContent = Object.create(null)
	let totalBytes = 0
	for (const candidate of boundedPaths(paths)) {
		const absolute = resolveContainedPath(root, candidate)
		const relative = path.relative(root, absolute).split(path.sep).join("/")
		const bytes = await readBoundedFile(root, absolute, Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - totalBytes))
		totalBytes += bytes?.length ?? 0
		content[relative] = bytes ? createHash("sha256").update(bytes).digest("hex") : "missing"
	}
	return content
}

/** Use the execution parser for patches so moves, deletions, and partial multi-file success are observable. */
export function extractMutationPaths(block: ToolUse): string[] | undefined {
	const args = block.nativeArgs as Record<string, unknown> | undefined
	const parameter = (name: "path" | "file_path" | "patch") => args?.[name] ?? block.params[name]
	let paths: string[]
	switch (block.name) {
		case "write_to_file":
		case "apply_diff":
		case "generate_image": {
			const candidate = parameter("path")
			if (typeof candidate !== "string" || !candidate)
				throw new VerificationScopeError("Mutation path is missing")
			paths = [candidate]
			break
		}
		case "edit":
		case "edit_file":
		case "search_replace":
		case "search_and_replace": {
			const candidate = parameter("file_path")
			if (typeof candidate !== "string" || !candidate)
				throw new VerificationScopeError("Mutation path is missing")
			paths = [candidate]
			break
		}
		case "apply_patch": {
			const patch = parameter("patch")
			if (typeof patch !== "string" || Buffer.byteLength(patch) > MAX_FILE_BYTES) {
				throw new VerificationScopeError("Mutation patch is missing or exceeds the bound")
			}
			paths = parsePatch(patch).hunks.flatMap((hunk) =>
				hunk.type === "UpdateFile" && hunk.movePath ? [hunk.path, hunk.movePath] : [hunk.path],
			)
			break
		}
		default:
			return undefined
	}
	return boundedPaths(paths)
}

export interface CommandVerificationScope {
	scopePath: string
	commandDigest: string
	repositoryDigest: string
	repositoryFiles: VerificationContent
	kind: "test" | "types" | "lint" | "format"
}

function commandTokens(command: string): string[] | undefined {
	// Reuse the Plan policy for executable admission below; this guard also applies
	// before resolving pnpm scripts, which Plan deliberately does not execute.
	if (!command.trim() || command.length > MAX_COMMAND_LENGTH || /[\\\0\r\n;&|<>`$%!^#*?()[\]{}~]/.test(command)) {
		return undefined
	}
	let quote: string | undefined
	for (const character of command) {
		if (quote === character) quote = undefined
		else if (!quote && (character === '"' || character === "'")) quote = character
	}
	if (quote) return undefined
	try {
		const tokens = parse(command)
		return tokens.length > 0 && tokens.every((token) => typeof token === "string")
			? (tokens as string[])
			: undefined
	} catch {
		return undefined
	}
}

function executableName(token: string): string {
	return token.toLowerCase().replace(/\.(?:cmd|exe)$/, "")
}

function withoutWorkerOptions(args: readonly string[]): string[] | undefined {
	const remaining: string[] = []
	for (let index = 0; index < args.length; index++) {
		const argument = args[index]
		if (argument === "--maxWorkers" || argument.startsWith("--maxWorkers=")) {
			const value = argument.includes("=") ? argument.slice(argument.indexOf("=") + 1) : args[++index]
			if (!value || !/^[1-9]\d{0,2}$/.test(value)) return undefined
		} else {
			remaining.push(argument)
		}
	}
	return remaining
}

function verifierKind(tokens: readonly string[]): CommandVerificationScope["kind"] | undefined {
	const executable = executableName(tokens[0])
	const args = tokens.slice(1)
	switch (executable) {
		case "vitest":
			return JSON.stringify(withoutWorkerOptions(args)) === '["run"]' ? "test" : undefined
		case "jest": {
			const remaining = withoutWorkerOptions(args)
			return remaining?.every((arg) => ["--ci", "--runInBand"].includes(arg)) ? "test" : undefined
		}
		case "tsc":
			return args.length === 1 && args[0] === "--noEmit" ? "types" : undefined
		case "eslint":
			return args[0] === "." && args.slice(1).every((arg) => /^--(?:max-warnings=0|ext=\.?[a-z,]+)$/.test(arg))
				? "lint"
				: undefined
		case "prettier":
			return args.length === 2 && args[0] === "--check" && args[1] === "." ? "format" : undefined
		case "python":
		case "python3":
			return args[0] === "-m" && args[1] === "pytest" ? verifierKind(["pytest", ...args.slice(2)]) : undefined
		case "pytest":
			return args.every((arg) => [".", "-q", "-v", "--quiet", "--verbose"].includes(arg)) ? "test" : undefined
		case "go":
			return args.length === 2 && ["test", "vet"].includes(args[0]) && args[1] === "./..."
				? args[0] === "test"
					? "test"
					: "lint"
				: undefined
		case "cargo":
			return args.length === 2 && ["test", "check", "clippy"].includes(args[0]) && args[1] === "--workspace"
				? args[0] === "test"
					? "test"
					: args[0] === "check"
						? "types"
						: "lint"
				: undefined
		default:
			return undefined
	}
}

function targetedVerifier(
	tokens: readonly string[],
): { kind: CommandVerificationScope["kind"]; targets: string[] } | undefined {
	const executable = executableName(tokens[0])
	let args = tokens.slice(1)
	let kind: CommandVerificationScope["kind"]
	if (executable === "vitest" && args[0] === "run") {
		args = withoutWorkerOptions(args.slice(1)) ?? []
		if (!args.every((arg) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(arg))) return undefined
		kind = "test"
	} else if (executable === "jest" && args.includes("--runTestsByPath")) {
		args = (withoutWorkerOptions(args) ?? []).filter(
			(arg) => !["--runTestsByPath", "--ci", "--runInBand"].includes(arg),
		)
		if (!args.every((arg) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(arg))) return undefined
		kind = "test"
	} else if (executable === "pytest") {
		args = args.filter((arg) => !["-q", "-v", "--quiet", "--verbose"].includes(arg))
		if (!args.every((arg) => /(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/.test(arg))) return undefined
		kind = "test"
	} else if (["python", "python3"].includes(executable) && args[0] === "-m" && args[1] === "pytest") {
		return targetedVerifier(["pytest", ...args.slice(2)])
	} else if (executable === "eslint") {
		args = args.filter((arg) => arg !== "--max-warnings=0")
		kind = "lint"
	} else if (executable === "prettier" && args[0] === "--check") {
		args = args.slice(1)
		kind = "format"
	} else {
		return undefined
	}
	return args.length > 0 && args.every((arg) => arg !== "." && !arg.startsWith("-"))
		? { kind, targets: args }
		: undefined
}

/** Cwd containment alone cannot make a language-specific check relevant to prose, assets, or another language. */
function verifierSupportsFiles(
	root: string,
	cwd: string,
	tokens: readonly string[],
	changedFiles: readonly string[],
): boolean {
	const executable = executableName(tokens[0])
	let extensions: RegExp
	let configFiles: readonly string[] = []
	switch (executable) {
		case "vitest":
		case "jest":
			extensions = /\.(?:[cm]?[jt]s|[jt]sx)$/
			configFiles =
				executable === "jest"
					? ["package.json", "tsconfig.json", "jest.config.json"]
					: ["package.json", "tsconfig.json"]
			break
		case "pytest":
		case "python":
		case "python3":
			extensions = /\.py$/
			configFiles = ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"]
			break
		case "go":
			extensions = /\.go$/
			configFiles = ["go.mod", "go.sum"]
			break
		case "cargo":
			extensions = /\.rs$/
			configFiles = ["Cargo.toml", "Cargo.lock"]
			break
		case "prettier":
			extensions = /\.(?:[cm]?[jt]s|[jt]sx|jsonc?|css|scss|less|html|vue|md|mdx|ya?ml|graphql|gql)$/
			break
		default:
			return true // TypeScript and ESLint inspect their effective config separately.
	}
	return changedFiles.every(
		(file) =>
			extensions.test(file) ||
			configFiles.some((config) => resolveContainedPath(root, file) === path.join(cwd, config)),
	)
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.length <= MAX_PATHS && value.every((item) => typeof item === "string")
		? value
		: undefined
}

/** A small documented TS glob subset; unsupported configuration never widens coverage. */
function configPattern(pattern: string, exclude = false): RegExp | undefined {
	if (!pattern || pattern.length > MAX_PATH_LENGTH || /[\\\0\r\n!{}[\]:]/.test(pattern)) return undefined
	let normalized = pattern.replace(/^\.\//, "").replace(/\/$/, "")
	if (normalized === ".") normalized = "**/*"
	const segments = normalized.split("/")
	if (segments.some((segment) => !segment || segment === ".." || (segment.includes("**") && segment !== "**")))
		return undefined
	if (!exclude && segments.at(-1) === "**") return undefined
	if (!/[.*?]/.test(segments.at(-1)!)) segments.push("**", "*")
	let expression = "^"
	for (const [index, segment] of segments.entries()) {
		if (segment === "**") expression += index === segments.length - 1 ? ".*" : "(?:[^/]+/)*"
		else {
			expression += segment.replace(/[.*+?^${}()|[\]\\]/g, (character) =>
				character === "*" ? "[^/]*" : character === "?" ? "[^/]" : `\\${character}`,
			)
			if (index < segments.length - 1) expression += "/"
		}
	}
	return new RegExp(`${expression}${exclude ? "(?:$|/)" : "$"}`, process.platform === "win32" ? "i" : "")
}

async function typeScriptCovers(root: string, cwd: string, changedFiles: readonly string[]): Promise<boolean> {
	let directory = cwd
	let config: Record<string, unknown> | undefined
	for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
		const bytes = await readBoundedFile(root, path.join(directory, "tsconfig.json"), MAX_MANIFEST_BYTES)
		if (bytes) {
			try {
				const parsed: unknown = JSON.parse(bytes.toString("utf8"))
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false
				config = parsed as Record<string, unknown>
			} catch {
				return false // JSONC, inheritance, and project references need a compiler-owned resolver.
			}
			break
		}
		if (directory === root) return false
		directory = path.dirname(directory)
	}
	if (!config || config.extends !== undefined || config.references !== undefined) return false
	const options = config.compilerOptions ?? {}
	if (!options || typeof options !== "object" || Array.isArray(options)) return false
	const compiler = options as Record<string, unknown>
	if (compiler.noCheck === true) return false
	const files = config.files === undefined ? [] : stringArray(config.files)
	const include =
		config.include === undefined ? (config.files === undefined ? ["**/*"] : []) : stringArray(config.include)
	const exclude =
		config.exclude === undefined
			? ["node_modules", "bower_components", "jspm_packages"]
			: stringArray(config.exclude)
	if (!files || !include || !exclude) return false
	if (files.some((file) => /[*?]/.test(file) || !configPattern(file))) return false
	const includes = include.map((pattern) => configPattern(pattern))
	const excludes = exclude.map((pattern) => configPattern(pattern, true))
	if (includes.some((pattern) => !pattern) || excludes.some((pattern) => !pattern)) return false
	if (compiler.outDir !== undefined) {
		if (typeof compiler.outDir !== "string") return false
		const outDir = configPattern(compiler.outDir, true)
		if (!outDir) return false
		excludes.push(outDir)
	}
	const explicit = new Set(files.map((file) => path.resolve(directory, file)))
	return changedFiles.every((file) => {
		const absolute = resolveContainedPath(root, file)
		if (absolute === path.join(directory, "tsconfig.json")) return true
		if (!/\.(?:[cm]?ts|tsx)$/.test(absolute) || (compiler.skipLibCheck === true && /\.d\.[cm]?ts$/.test(absolute)))
			return false
		const relative = path.relative(directory, absolute).split(path.sep).join("/")
		if (explicit.has(absolute)) return true
		if (
			relative
				.split("/")
				.some(
					(segment) =>
						segment.startsWith(".") ||
						["node_modules", "bower_components", "jspm_packages"].includes(segment),
				)
		)
			return false
		return (
			includes.some((pattern) => pattern!.test(relative)) && !excludes.some((pattern) => pattern!.test(relative))
		)
	})
}

const MODULE_FILES = ["package.json", "go.mod", "Cargo.toml", "pyproject.toml", "pytest.ini"] as const

function nestedRequirementPaths(root: string, cwd: string, changedFiles: readonly string[]): string[] {
	const result = new Set<string>()
	for (const file of boundedPaths(changedFiles)) {
		const absolute = resolveContainedPath(root, file)
		if (!containsPath(cwd, absolute)) return []
		let directory = path.dirname(absolute)
		for (let depth = 0; directory !== cwd; depth++) {
			if (depth >= MAX_ANCESTORS) throw new VerificationScopeError("Change scope exceeds the ancestor bound")
			for (const name of MODULE_FILES) result.add(path.join(directory, name))
			if (result.size > MAX_PATHS) throw new VerificationScopeError("Change scope exceeds the path bound")
			directory = path.dirname(directory)
		}
	}
	return [...result]
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

/** Only inert JSON literals are inspected. Never infer dynamic JS configuration from absent keywords. */
function literalConfiguration(bytes: Buffer): unknown {
	const source = bytes.toString("utf8").trim()
	const literal = source.replace(/^(?:export\s+default\s+|module\.exports\s*=\s*)/, "").replace(/;$/, "")
	try {
		return JSON.parse(literal)
	} catch {
		return undefined
	}
}

function testConfigurationIsSupported(value: unknown, executable: string): boolean {
	const config = objectRecord(value)
	if (!config) return false
	const test = executable === "vitest" ? objectRecord(config.test ?? {}) : config
	if (!test || (executable === "vitest" && Object.keys(config).some((key) => key !== "test"))) return false
	return Object.entries(test).every(([key, value]) => {
		if (["globals", "silent", "verbose", "clearMocks", "resetMocks", "restoreMocks"].includes(key))
			return typeof value === "boolean"
		if (key === "watch") return value === false
		return (
			["testTimeout", "hookTimeout", "maxWorkers"].includes(key) &&
			Number.isSafeInteger(value) &&
			Number(value) > 0
		)
	})
}

async function knownTestScopeIsSupported(root: string, cwd: string, tokens: readonly string[]): Promise<boolean> {
	const executable = executableName(tokens[0])
	const prefixes =
		executable === "vitest" ? ["vitest.config.", "vite.config."] : executable === "jest" ? ["jest.config."] : []
	let directory = cwd
	for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
		// Installed Vitest/Jest search upward for configuration. A nested cwd does not hide an ancestor config.
		for (const file of REQUIREMENT_FILES.filter((file) => prefixes.some((prefix) => file.startsWith(prefix)))) {
			const bytes = await readBoundedFile(root, path.join(directory, file), MAX_MANIFEST_BYTES)
			if (bytes && !testConfigurationIsSupported(literalConfiguration(bytes), executable)) return false
		}
		if (executable === "jest") {
			const manifest = await readBoundedFile(root, path.join(directory, "package.json"), MAX_MANIFEST_BYTES)
			if (manifest) {
				const parsed = objectRecord(literalConfiguration(manifest))
				if (!parsed || (parsed.jest !== undefined && !testConfigurationIsSupported(parsed.jest, executable)))
					return false
			}
		}
		if (["pytest", "python", "python3"].includes(executable)) {
			for (const file of ["pyproject.toml", "pytest.ini", "setup.cfg", "tox.ini"]) {
				const bytes = await readBoundedFile(root, path.join(directory, file), MAX_MANIFEST_BYTES)
				if (bytes && /\b(?:testpaths|norecursedirs|addopts|python_files)["']?\s*=/.test(bytes.toString("utf8")))
					return false
			}
		}
		if (directory === root) return true
		directory = path.dirname(directory)
	}
	return false
}

const ESLINT_FLAT_FILES = [
	"eslint.config.js",
	"eslint.config.mjs",
	"eslint.config.cjs",
	"eslint.config.ts",
	"eslint.config.mts",
	"eslint.config.cts",
] as const
const ESLINT_LEGACY_FILES = [
	".eslintrc",
	".eslintrc.js",
	".eslintrc.cjs",
	".eslintrc.json",
	".eslintrc.yaml",
	".eslintrc.yml",
	".eslintignore",
] as const

async function eslintCovers(
	root: string,
	cwd: string,
	tokens: readonly string[],
	changedFiles: readonly string[],
): Promise<boolean> {
	if (changedFiles.some((file) => !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file))) return false
	let directory = cwd
	let config: unknown
	for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
		// Legacy cascading and executable config imports need an ESLint-owned resolver.
		for (const file of ESLINT_LEGACY_FILES) {
			if (await readBoundedFile(root, path.join(directory, file), MAX_MANIFEST_BYTES)) return false
		}
		for (const file of ESLINT_FLAT_FILES) {
			const bytes = await readBoundedFile(root, path.join(directory, file), MAX_MANIFEST_BYTES)
			if (bytes) {
				config = literalConfiguration(bytes)
				if (!Array.isArray(config)) return false
				break
			}
		}
		if (config !== undefined || directory === root) break
		directory = path.dirname(directory)
	}
	if (!Array.isArray(config) || config.length === 0 || config.length > MAX_PATHS) return false
	const entries: Array<{ files?: RegExp[]; ignores: RegExp[]; rules: Record<string, unknown> }> = []
	for (const value of config) {
		const item = objectRecord(value)
		if (!item || Object.keys(item).some((key) => !["files", "ignores", "rules"].includes(key))) return false
		const files = item.files === undefined ? undefined : stringArray(item.files)
		const ignores = item.ignores === undefined ? [] : stringArray(item.ignores)
		const rules = objectRecord(item.rules ?? {})
		if ((item.files !== undefined && !files) || !ignores || !rules) return false
		// Bare directory includes have different semantics across config ecosystems.
		if (files?.some((file) => !/[.*?]/.test(file.split("/").at(-1) ?? ""))) return false
		const filePatterns = files?.map((file) => configPattern(file))
		const ignorePatterns = ignores.map((file) => configPattern(file, true))
		if (filePatterns?.some((pattern) => !pattern) || ignorePatterns.some((pattern) => !pattern)) return false
		entries.push({ files: filePatterns as RegExp[] | undefined, ignores: ignorePatterns as RegExp[], rules })
	}
	const extensions = tokens
		.filter((token) => token.startsWith("--ext="))
		.flatMap((token) =>
			token
				.slice(6)
				.split(",")
				.map((extension) => `.${extension.replace(/^\./, "")}`),
		)
	return changedFiles.every((file) => {
		const absolute = resolveContainedPath(root, file)
		const relative = path.relative(directory, absolute).split(path.sep).join("/")
		if (relative.split("/").some((part) => part === "node_modules" || part === ".git")) return false
		if (entries.some((entry) => entry.ignores.some((pattern) => pattern.test(relative)))) return false
		const matching = entries.filter(
			(entry) => !entry.files || entry.files.some((pattern) => pattern.test(relative)),
		)
		const hasExtension =
			/\.[cm]?js$/.test(file) ||
			extensions.includes(path.extname(file)) ||
			matching.some((entry) => entry.files !== undefined)
		const rules = Object.assign(Object.create(null), ...matching.map((entry) => entry.rules)) as Record<
			string,
			unknown
		>
		return (
			hasExtension &&
			Object.values(rules).some((setting) => {
				const severity = Array.isArray(setting) ? setting[0] : setting
				return severity === "warn" || severity === "error" || severity === 1 || severity === 2
			})
		)
	})
}

async function findPackageScript(
	root: string,
	cwd: string,
	scriptName: string,
): Promise<{ cwd: string; script: string } | undefined> {
	let candidate = cwd
	for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
		const bytes = await readBoundedFile(root, path.join(candidate, "package.json"), MAX_MANIFEST_BYTES)
		if (bytes) {
			const manifest: unknown = JSON.parse(bytes.toString("utf8"))
			if (!manifest || typeof manifest !== "object" || !("scripts" in manifest)) return undefined
			const scripts = manifest.scripts
			if (!scripts || typeof scripts !== "object" || !(scriptName in scripts)) return undefined
			const script: unknown = scripts[scriptName as keyof typeof scripts]
			return typeof script === "string" ? { cwd: candidate, script } : undefined
		}
		if (candidate === root) return undefined
		candidate = path.dirname(candidate)
	}
	throw new VerificationScopeError("Package lookup exceeds the ancestor bound")
}

const REQUIREMENT_FILES = [
	"AGENTS.md",
	"AGENTS.override.md",
	"package.json",
	"tsconfig.json",
	"vitest.config.ts",
	"vitest.config.js",
	"vitest.config.mts",
	"vitest.config.cts",
	"vitest.config.mjs",
	"vitest.config.cjs",
	"vite.config.ts",
	"vite.config.js",
	"vite.config.mts",
	"vite.config.cts",
	"vite.config.mjs",
	"vite.config.cjs",
	"jest.config.js",
	"jest.config.ts",
	"jest.config.mjs",
	"jest.config.cjs",
	"jest.config.json",
	...ESLINT_FLAT_FILES,
	...ESLINT_LEGACY_FILES,
	".prettierrc.json",
	"pyproject.toml",
	"pytest.ini",
	"setup.cfg",
	"tox.ini",
	"Cargo.toml",
	"go.mod",
	"go.work",
] as const

function ancestorRequirementPaths(root: string, directories: readonly string[]): string[] {
	const paths = new Set<string>()
	for (const start of directories) {
		let directory = start
		for (let depth = 0; ; depth++) {
			if (depth >= MAX_ANCESTORS)
				throw new VerificationScopeError("Requirement lookup exceeds the ancestor bound")
			for (const file of REQUIREMENT_FILES) paths.add(path.join(directory, file))
			if (paths.size > MAX_PATHS)
				throw new VerificationScopeError("Verification requirements exceed the path bound")
			if (directory === root) break
			directory = path.dirname(directory)
		}
	}
	return [...paths]
}

/** Seed dependency versions independently of changedFiles before the first scoped verification. */
export async function captureVerificationDependencies(
	workspaceRoot: string,
	changedFiles: readonly string[],
): Promise<VerificationContent> {
	const root = await fs.realpath(workspaceRoot)
	const directories = boundedPaths(changedFiles).map((file) => path.dirname(resolveContainedPath(root, file)))
	return captureVerificationContent(root, ancestorRequirementPaths(root, directories))
}

/**
 * Admission is evidence scope, not a statement that a command succeeded. The
 * caller must capture this before execution and require the same identity at
 * authoritative successful completion, together with unchanged content versions.
 */
export async function resolveCommandVerification(input: {
	workspaceRoot: string
	cwd: string
	command: string
	/** Actual edited paths only; content-dependency paths must not be passed as edits. */
	changedFiles?: readonly string[]
}): Promise<CommandVerificationScope | undefined> {
	let tokens = commandTokens(input.command)
	if (!tokens) return undefined
	const root = await fs.realpath(input.workspaceRoot)
	let cwd = await realContainedPath(root, resolveContainedPath(root, input.cwd))
	if (!cwd || !(await fs.stat(cwd)).isDirectory()) throw new VerificationScopeError("Verification cwd is unavailable")
	if (executableName(tokens[0]) === "pnpm") {
		let index = 1
		if (tokens[index] === "--dir") {
			const directory = tokens[++index]
			if (!directory) return undefined
			cwd = await realContainedPath(root, resolveContainedPath(root, path.resolve(cwd, directory)))
			if (!cwd || !(await fs.stat(cwd)).isDirectory()) {
				throw new VerificationScopeError("Verification cwd is unavailable")
			}
			index++
		}
		if (tokens[index] === "exec") {
			tokens = tokens.slice(index + 1)
		} else {
			if (tokens[index] === "run") index++
			const scriptName = tokens[index++]
			if (!["test", "check-types", "lint"].includes(scriptName)) return undefined
			const script = await findPackageScript(root, cwd, scriptName)
			if (!script) return undefined
			const scriptTokens = commandTokens(script.script)
			if (!scriptTokens) return undefined
			cwd = script.cwd
			tokens = [...scriptTokens, ...tokens.slice(index)]
		}
	}
	if (tokens.length === 0) return undefined
	const command = tokens.map((token) => JSON.stringify(token)).join(" ")
	const plan = classifyPlanCommand(command)
	if (!plan.allowed || plan.category !== "verification") return undefined
	const wholeScopeKind = verifierKind(tokens)
	const targeted = wholeScopeKind ? undefined : targetedVerifier(tokens)
	const kind = wholeScopeKind ?? targeted?.kind
	if (!kind) return undefined
	const changedFiles = input.changedFiles
	if (targeted && (!changedFiles || changedFiles.length === 0)) return undefined
	if (changedFiles) {
		const changedPaths = boundedPaths(changedFiles).map((file) => resolveContainedPath(root, file))
		if (!changedPaths.every((file) => containsPath(cwd, file))) return undefined
		if (!verifierSupportsFiles(root, cwd, tokens, changedFiles)) return undefined
		if (targeted) {
			const targets = boundedPaths(targeted.targets).map((file) =>
				resolveContainedPath(root, path.resolve(cwd, file)),
			)
			if (!changedPaths.every((file) => targets.includes(file))) return undefined
			for (const target of targets) {
				const real = await realContainedPath(root, target)
				if (!real || !(await fs.stat(real)).isFile()) return undefined
			}
		}
		if (executableName(tokens[0]) === "tsc" && !(await typeScriptCovers(root, cwd, changedFiles))) return undefined
		if (executableName(tokens[0]) === "eslint" && !(await eslintCovers(root, cwd, tokens, changedFiles)))
			return undefined
		if (kind === "test" && !(await knownTestScopeIsSupported(root, cwd, tokens))) return undefined
	}
	const requirementPaths = ancestorRequirementPaths(root, [cwd])
	const nestedPaths =
		changedFiles && executableName(tokens[0]) !== "tsc" ? nestedRequirementPaths(root, cwd, changedFiles) : []
	const requirements = await captureVerificationContent(root, [...new Set([...requirementPaths, ...nestedPaths])])
	if (nestedPaths.some((file) => requirements[path.relative(root, file).split(path.sep).join("/")] !== "missing"))
		return undefined
	if (changedFiles && executableName(tokens[0]) === "go") {
		if (requirements[path.relative(root, path.join(cwd, "go.work")).split(path.sep).join("/")] !== "missing")
			return undefined
		if (
			changedFiles.some((file) =>
				path
					.relative(cwd, resolveContainedPath(root, file))
					.split(path.sep)
					.some(
						(part) =>
							part === "vendor" || part === "testdata" || part.startsWith(".") || part.startsWith("_"),
					),
			)
		)
			return undefined
	}
	return {
		scopePath: cwd,
		kind,
		commandDigest: fingerprintContent(JSON.stringify([cwd, tokens])),
		repositoryDigest: fingerprintContent(JSON.stringify(requirements)),
		repositoryFiles: requirements,
	}
}

export interface GitMutationState {
	head: string | null
	files: VerificationContent
	digest: string
}

export type WorkspaceMutationState = GitMutationState & { kind: "git" | "files" }

async function gitObservation(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync(
		"git",
		["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args],
		{ cwd, encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES, timeout: 5_000, windowsHide: true },
	)
	return stdout
}

async function readGitHead(cwd: string): Promise<string | null> {
	try {
		return (await gitObservation(cwd, ["rev-parse", "--verify", "-q", "HEAD"])).trim()
	} catch (error) {
		if ((error as { code?: number }).code === 1) return null // Unborn repository.
		throw error
	}
}

/** Bounded Git-visible state only; unknown/non-Git/submodule/oversized observations fail closed. */
export async function captureGitMutationState(workspaceRoot: string): Promise<GitMutationState> {
	const root = await fs.realpath(workspaceRoot)
	const gitRoot = await fs.realpath((await gitObservation(root, ["rev-parse", "--show-toplevel"])).trim())
	if (gitRoot !== root) throw new VerificationScopeError("Git observation requires the workspace repository root")
	const head = await readGitHead(root)
	const status = await gitObservation(root, [
		"status",
		"--porcelain=v1",
		"-z",
		"--untracked-files=all",
		"--no-renames",
		"--ignore-submodules=none",
	])
	// Status omits tracked files marked assume-unchanged/skip-worktree; their bytes remain task inputs.
	const trackedFlags = await gitObservation(root, ["ls-files", "-v", "-z"])
	const hiddenTrackedPaths = trackedFlags
		.split("\0")
		.filter(Boolean)
		.flatMap((record) => {
			if (!/^[A-Za-z?] /.test(record))
				throw new VerificationScopeError("Unsupported Git tracked-file observation")
			return record[0] === "S" || /^[a-z]/.test(record) ? [record.slice(2)] : []
		})
	const paths = status
		.split("\0")
		.filter(Boolean)
		.map((record) => {
			if (!/^[ MADRCU?!]{2} /.test(record) || /[RCU!]/.test(record.slice(0, 2))) {
				throw new VerificationScopeError("Unsupported Git status observation")
			}
			return record.slice(3)
		})
	const files = await captureVerificationContent(root, [...new Set([...paths, ...hiddenTrackedPaths])])
	if (head !== (await readGitHead(root))) throw new VerificationScopeError("Git HEAD changed while observing changes")
	return { head, files, digest: fingerprintContent(JSON.stringify([head, files])) }
}

/** Refresh files that became clean, since their content is absent from the second dirty-file map. */
export async function compareGitMutationState(
	workspaceRoot: string,
	before: GitMutationState,
	after: GitMutationState,
): Promise<{ changedPaths: string[]; files: VerificationContent }> {
	if (before.head !== after.head)
		throw new VerificationScopeError("Git HEAD changed; the command change scope is unknown")
	const candidates = boundedPaths([...new Set([...Object.keys(before.files), ...Object.keys(after.files)])])
	const refreshed = await captureVerificationContent(workspaceRoot, candidates)
	if ((await readGitHead(workspaceRoot)) !== after.head) {
		throw new VerificationScopeError("Git HEAD changed while comparing command changes")
	}
	const changedPaths = candidates.filter((candidate) => before.files[candidate] !== refreshed[candidate])
	return {
		changedPaths,
		files: Object.fromEntries(changedPaths.map((candidate) => [candidate, refreshed[candidate]])),
	}
}

async function workspaceFilePaths(root: string): Promise<string[]> {
	const files: string[] = []
	let entries = 0
	async function visit(directory: string, depth: number): Promise<void> {
		if (depth > MAX_ANCESTORS) throw new VerificationScopeError("Workspace observation exceeds the depth bound")
		for await (const entry of await fs.opendir(directory)) {
			if (entry.name === ".git" || entry.name === "node_modules") continue
			if (++entries > MAX_PATHS * 2)
				throw new VerificationScopeError("Workspace observation exceeds the entry bound")
			const absolute = path.join(directory, entry.name)
			const stat = await fs.lstat(absolute)
			if (stat.isSymbolicLink()) {
				throw new VerificationScopeError("Workspace observation cannot follow symlinks or special files")
			} else if (stat.isDirectory()) {
				if ((await realContainedPath(root, absolute)) !== absolute) {
					throw new VerificationScopeError("Workspace observation cannot follow symlinks or special files")
				}
				await visit(absolute, depth + 1)
			} else if (stat.isFile()) {
				files.push(path.relative(root, absolute).split(path.sep).join("/"))
				if (files.length > MAX_PATHS)
					throw new VerificationScopeError("Workspace observation exceeds the file bound")
			} else {
				throw new VerificationScopeError("Workspace observation cannot follow symlinks or special files")
			}
		}
	}
	await visit(root, 0)
	return files.sort()
}

/** Non-Git workspaces use a full bounded snapshot; unobserved shell writes must not silently pass. */
export async function captureWorkspaceMutationState(workspaceRoot: string): Promise<WorkspaceMutationState> {
	const root = await fs.realpath(workspaceRoot)
	let hasGitDirectory = true
	try {
		await fs.lstat(path.join(root, ".git"))
	} catch (error) {
		if (!isMissing(error)) throw error
		hasGitDirectory = false
	}
	if (hasGitDirectory) return { ...(await captureGitMutationState(root)), kind: "git" }
	const paths = await workspaceFilePaths(root)
	const files = await captureVerificationContent(root, paths)
	if (JSON.stringify(paths) !== JSON.stringify(await workspaceFilePaths(root))) {
		throw new VerificationScopeError("Workspace files changed while observing command changes")
	}
	return { kind: "files", head: null, files, digest: fingerprintContent(JSON.stringify(files)) }
}

export async function compareWorkspaceMutationState(
	workspaceRoot: string,
	before: WorkspaceMutationState,
	after: WorkspaceMutationState,
): Promise<{ changedPaths: string[]; files: VerificationContent }> {
	if (before.kind !== after.kind)
		throw new VerificationScopeError("Workspace observation changed during command execution")
	if (before.kind === "git") return compareGitMutationState(workspaceRoot, before, after)
	const candidates = boundedPaths([...new Set([...Object.keys(before.files), ...Object.keys(after.files)])])
	const refreshed = await captureVerificationContent(workspaceRoot, candidates)
	const changedPaths = candidates.filter((candidate) => before.files[candidate] !== refreshed[candidate])
	return {
		changedPaths,
		files: Object.fromEntries(changedPaths.map((candidate) => [candidate, refreshed[candidate]])),
	}
}
