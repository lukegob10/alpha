import { randomBytes } from "crypto"
import { constants } from "fs"
import fs from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { z } from "zod"

import type { PytestVerificationLaunch } from "../../integrations/terminal/PytestVerificationLauncher"
import { pythonVerificationObserverSource } from "./PytestVerificationObserver"
import type { CommandVerificationDiagnostic } from "./VerificationScope"

const MAX_REPORT_BYTES = 256 * 1_024
const MAX_FILES = 256
const boundedString = z
	.string()
	.min(1)
	.max(4_096)
	.refine((value) => !/[\0\r\n]/.test(value))
const count = z.number().int().nonnegative().refine(Number.isSafeInteger)
const receiptSchema = z
	.object({
		schemaVersion: z.literal(1),
		executionId: boundedString,
		nonce: boundedString,
		commandDigest: boundedString,
		cwd: boundedString,
		rootPath: boundedString,
		configPath: boundedString.nullable(),
		pytestVersion: z.string().min(1).max(128),
		collectionCompleted: z.boolean(),
		unsupported: z.string().max(4_096).optional(),
		selection: z
			.object({
				keyword: z.string().max(4_096),
				markexpr: z.string().max(4_096),
				collectonly: z.boolean(),
				lf: z.boolean(),
				stepwise: z.boolean(),
				ignore: z.array(boundedString).max(MAX_FILES),
				ignoreGlob: z.array(boundedString).max(MAX_FILES),
				deselect: z.array(boundedString).max(MAX_FILES),
			})
			.strict(),
		files: z
			.array(
				z
					.object({ path: boundedString, collected: count, passed: count, skipped: count, failed: count })
					.strict(),
			)
			.max(MAX_FILES),
		exitStatus: z.number().int(),
	})
	.strict()

export interface PytestVerificationCompletion {
	validated: boolean
	diagnostic?: CommandVerificationDiagnostic
}

function unavailable(reason: string): PytestVerificationCompletion {
	return {
		validated: false,
		diagnostic: {
			code: "runtime_scope_unavailable",
			message: `Pytest runtime verification is unavailable: ${reason} Run the unfiltered suite again with its observer available, or report these changes as unverified.`,
		},
	}
}

function contained(root: string, target: string): boolean {
	const relative = path.relative(root, target)
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
}

/** Observes actual suite execution; this receipt does not establish source-code coverage. */
export async function createPytestVerificationReceipt(input: {
	executionId: string
	commandDigest: string
	cwd: string
	workspaceRoot: string
	expectedFiles: readonly string[]
	configFiles: readonly string[]
}): Promise<{
	launch: PytestVerificationLaunch
	complete(): Promise<PytestVerificationCompletion>
	dispose(): Promise<void>
}> {
	// Bind receipt identity and scope before the first asynchronous filesystem operation.
	input = { ...input, expectedFiles: [...input.expectedFiles], configFiles: [...input.configFiles] }
	if (
		!boundedString.safeParse(input.executionId).success ||
		input.executionId.length > 256 ||
		!boundedString.safeParse(input.commandDigest).success ||
		input.expectedFiles.length > MAX_FILES ||
		input.configFiles.length > MAX_FILES
	)
		throw new Error("Invalid pytest verification receipt inputs")
	const workspaceRoot = await fs.realpath(input.workspaceRoot)
	const cwd = await fs.realpath(input.cwd)
	if (!contained(workspaceRoot, cwd)) throw new Error("Pytest verification cwd is outside the workspace")
	const normalizeInput = (file: string) => {
		if (!boundedString.safeParse(file).success) throw new Error("Invalid pytest verification path")
		const absolute = path.resolve(workspaceRoot, file)
		if (!contained(workspaceRoot, absolute)) throw new Error("Pytest verification path is outside the workspace")
		return absolute
	}
	const expectedFiles = input.expectedFiles.map(normalizeInput)
	const configFiles = input.configFiles.map(normalizeInput)
	const parentDirectory = await fs.realpath(tmpdir())
	if (contained(workspaceRoot, parentDirectory))
		throw new Error("A private pytest receipt directory outside the workspace is unavailable")
	const moduleDirectory = await fs.mkdtemp(path.join(parentDirectory, "alpha-pytest-receipt-"))
	const directoryIdentity = await fs.lstat(moduleDirectory)
	const nonce = randomBytes(32).toString("hex")
	const moduleName = `_alpha_pytest_${randomBytes(16).toString("hex")}`
	const reportPath = path.join(moduleDirectory, "receipt.json")
	const launch: PytestVerificationLaunch = Object.freeze({
		executionId: input.executionId,
		moduleName,
		moduleDirectory,
		reportPath,
	})
	let completion: Promise<PytestVerificationCompletion> | undefined
	let disposal: Promise<void> | undefined
	let disposed = false

	const verifyPrivateDirectory = async () => {
		const resolved = path.resolve(moduleDirectory)
		if (path.dirname(resolved) !== parentDirectory || !path.basename(resolved).startsWith("alpha-pytest-receipt-"))
			throw new Error("Invalid pytest receipt cleanup directory")
		const current = await fs.lstat(resolved)
		if (
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			current.dev !== directoryIdentity.dev ||
			current.ino !== directoryIdentity.ino ||
			(await fs.realpath(resolved)) !== resolved
		)
			throw new Error("Pytest receipt directory identity changed")
	}
	const dispose = () => {
		if (!disposal) {
			disposed = true
			disposal = (async () => {
				if (completion) await completion
				await verifyPrivateDirectory()
				await fs.rm(moduleDirectory, { recursive: true, force: true })
			})()
		}
		return disposal
	}
	try {
		await fs.writeFile(
			path.join(moduleDirectory, `${moduleName}.py`),
			pythonVerificationObserverSource({
				executionId: input.executionId,
				nonce,
				commandDigest: input.commandDigest,
				reportPath,
			}),
			{ flag: "wx", mode: 0o600 },
		)
	} catch (error) {
		await dispose()
		throw error
	}

	const realWorkspacePath = async (file: string) => {
		if (!path.isAbsolute(file)) throw new Error("Receipt path is not absolute")
		// Terminal cwd and Python paths may retain Windows short names or a workspace
		// junction alias. Compare canonical identities without relaxing final containment.
		const real = await fs.realpath(file)
		if (!contained(workspaceRoot, real)) throw new Error("Receipt path resolves outside the workspace")
		return real
	}
	const inspect = async (): Promise<PytestVerificationCompletion> => {
		try {
			await verifyPrivateDirectory()
			const before = await fs.lstat(reportPath)
			if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_REPORT_BYTES)
				return unavailable("the observer report is not a bounded regular file.")
			const handle = await fs.open(reportPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
			let source: string
			try {
				const opened = await handle.stat()
				if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
					return unavailable("the observer report changed while opening it.")
				const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1)
				let length = 0
				while (length < buffer.length) {
					const read = await handle.read(buffer, length, buffer.length - length, length)
					if (read.bytesRead === 0) break
					length += read.bytesRead
				}
				const after = await handle.stat()
				const current = await fs.lstat(reportPath)
				if (
					length !== before.size ||
					current.isSymbolicLink() ||
					current.dev !== before.dev ||
					current.ino !== before.ino ||
					current.size !== before.size ||
					after.size !== before.size ||
					after.mtimeMs !== before.mtimeMs ||
					after.ctimeMs !== before.ctimeMs
				)
					return unavailable("the observer report changed during inspection.")
				source = buffer.subarray(0, length).toString("utf8")
			} finally {
				await handle.close()
			}
			const parsed = receiptSchema.safeParse(JSON.parse(source))
			if (!parsed.success) return unavailable("the observer report has an unknown or malformed format.")
			const report = parsed.data
			if (
				report.executionId !== input.executionId ||
				report.nonce !== nonce ||
				report.commandDigest !== input.commandDigest ||
				(await realWorkspacePath(report.cwd)) !== cwd
			)
				return unavailable("the observer report belongs to a different execution or working directory.")
			const runtimeRoot = await realWorkspacePath(report.rootPath)
			if (!(await fs.stat(runtimeRoot)).isDirectory())
				return unavailable("the runtime project root is unavailable.")
			if (report.configPath !== null) {
				const config = await realWorkspacePath(report.configPath)
				if (!configFiles.includes(config) || !(await fs.stat(config)).isFile())
					return unavailable("pytest selected an unobserved configuration file.")
			}
			const selection = report.selection
			if (
				!report.collectionCompleted ||
				report.exitStatus !== 0 ||
				report.unsupported !== undefined ||
				selection.keyword ||
				selection.markexpr ||
				selection.collectonly ||
				selection.lf ||
				selection.stepwise ||
				selection.ignore.length ||
				selection.ignoreGlob.length ||
				selection.deselect.length
			)
				return unavailable("pytest did not complete an unfiltered supported test session.")
			const observed = new Map<string, (typeof report.files)[number]>()
			let total = 0
			for (const file of report.files) {
				const real = await realWorkspacePath(file.path)
				if (
					observed.has(real) ||
					!(await fs.stat(real)).isFile() ||
					file.failed > 0 ||
					!Number.isSafeInteger(file.passed + file.skipped + file.failed) ||
					file.passed + file.skipped + file.failed !== file.collected
				)
					return unavailable("the observer reported duplicate, failed, or inconsistent test files.")
				total += file.collected
				if (!Number.isSafeInteger(total))
					return unavailable("the observer test counts exceed the supported bound.")
				observed.set(real, file)
			}
			if (!expectedFiles.length) return unavailable("no expected test files were established before execution.")
			for (const expected of expectedFiles) {
				const file = observed.get(await realWorkspacePath(expected))
				if (!file || file.collected === 0 || file.passed === 0)
					return unavailable("an expected test file was not collected and passed.")
			}
			return { validated: true }
		} catch {
			return unavailable("the observer report is missing, unreadable, stale, or contains unavailable paths.")
		}
	}
	return {
		launch,
		complete: () =>
			(completion ??= disposed
				? Promise.resolve(unavailable("the observer was disposed before validation."))
				: inspect()),
		dispose,
	}
}
