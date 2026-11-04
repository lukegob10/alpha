import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { pathToFileURL } from "node:url"
import { hostVsixTarget } from "../../src/lancedb-native.mjs"
import { pnpmInvocation } from "./pnpm.mjs"
import { readJson } from "./release-quality.mjs"

const execute = promisify(execFile)
const sha = (value, length = 64) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "u").test(value)
const id = (value) => typeof value === "string" && /^[1-9][0-9]{0,19}$/u.test(value)
const requireFact = (condition, reason) => {
	if (!condition) throw new Error(`release_evidence:${reason}`)
}
const ageLimit = 24 * 60 * 60 * 1000

// These are release obligations over the existing harness, not alternative test implementations.
export const releaseValidationPlatforms = Object.freeze({
	static: "win32",
	turns: "win32",
	unit: "win32",
	tooling: "win32",
	offline: "win32",
	host: "win32",
	minimum: "win32",
	extended: "win32",
	confidence: "win32",
	rendered: "win32",
	stress: "win32",
	outcomes: "win32",
	"command-approval": "win32",
})
export const releaseTargets = Object.freeze([
	"win32-x64",
	"win32-arm64",
	"darwin-arm64",
	"darwin-x64",
	"linux-x64",
	"linux-arm64",
])

export function requireReleaseNeeds(needs, publication = false) {
	const required = ["live-quality", "validation", "package-vsix", ...(publication ? ["release-gate"] : [])]
	requireFact(
		needs &&
			typeof needs === "object" &&
			!Array.isArray(needs) &&
			Object.keys(needs).length === required.length &&
			required.every((job) => Object.hasOwn(needs, job) && needs[job]?.result === "success"),
		"required_job_not_successful",
	)
	return Object.fromEntries(required.map((job) => [job, { result: needs[job].result }]))
}

async function git(root, args) {
	return (
		await execute("git", args, {
			cwd: root,
			encoding: "utf8",
			windowsHide: true,
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
		})
	).stdout.trim()
}

async function collectContext(root, role, env) {
	const { collectSource } = await import("./source.mjs")
	const manifest = (await readJson(path.join(root, "package.json"))).value
	const invocation = pnpmInvocation(env.npm_execpath, ["--version"])
	const pnpm = (
		await execute(invocation.executable, invocation.args, { encoding: "utf8", windowsHide: true, timeout: 30_000 })
	).stdout.trim()
	const source = await collectSource(root)
	requireFact(
		env.GITHUB_ACTIONS === "true" && id(env.GITHUB_RUN_ID) && id(env.GITHUB_RUN_ATTEMPT) && env.GITHUB_JOB === role,
		"ci_identity_unavailable",
	)
	requireFact(
		sha(env.GITHUB_SHA, 40) && source.commit === env.GITHUB_SHA && source.dirty === false,
		"unclean_or_wrong_candidate",
	)
	requireFact(
		process.versions.node === manifest.engines.node && `pnpm@${pnpm}` === manifest.packageManager,
		"wrong_toolchain",
	)
	return {
		source,
		gitTree: await git(root, ["rev-parse", "HEAD^{tree}"]),
		node: process.versions.node,
		pnpm,
		platform: process.platform,
		arch: process.arch,
		createdAt: new Date().toISOString(),
		ci: { runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, job: role },
	}
}

export function validateJobContext(context, expected, role, platform, now = Date.now()) {
	const created = Date.parse(context?.createdAt)
	requireFact(
		context?.ci?.runId === expected.ci.runId &&
			context.ci.runAttempt === expected.ci.runAttempt &&
			context.ci.job === role,
		"wrong_run_or_attempt",
	)
	requireFact(
		context.source?.commit === expected.source.commit &&
			context.source.dirty === false &&
			sha(context.source.treeSha256) &&
			sha(context.source.lockfileSha256),
		"wrong_source",
	)
	requireFact(sha(context.gitTree, 40) && context.gitTree === expected.gitTree, "wrong_git_tree")
	requireFact(context.node === expected.node && context.pnpm === expected.pnpm, "wrong_toolchain")
	requireFact(context.platform === platform && ["x64", "arm64"].includes(context.arch), "wrong_runner")
	requireFact(
		Number.isFinite(created) && created <= now + 60_000 && now - created <= ageLimit,
		"expired_job_evidence",
	)
}

export async function validateValidationEvidence(value, { root, expected, now = Date.now() }) {
	requireFact(
		value?.schemaVersion === 1 &&
			value.kind === "alpha-release-validation" &&
			Object.hasOwn(releaseValidationPlatforms, value.lane),
		"invalid_validation_bundle",
	)
	validateJobContext(value.context, expected, "validation", releaseValidationPlatforms[value.lane], now)
	requireFact(
		value.report?.lane === value.lane && Array.isArray(value.report.filters) && value.report.filters.length === 0,
		"wrong_validation_lane",
	)
	const [{ admitHarnessReport }, { selectLane }, { laneExpectedInventories }] = await Promise.all([
		import("./matrix.mjs"),
		import("./catalog.mjs"),
		import("./lane-evidence.mjs"),
	])
	const expectedInventories = await laneExpectedInventories(root, selectLane(value.lane), value.lane)
	const admission = admitHarnessReport(value.report, {
		source: value.context.source,
		node: expected.node,
		pnpm: expected.pnpm,
		now,
		strict: !["unit", "tooling"].includes(value.lane),
		expectedInventories,
		outcomeBuild: value.outcomeBuild,
	})
	// Preserve declared unit/host-runner supplemental skips. Each requireAllTests descriptor still applies.
	const accepted =
		admission.state === "executed-pass" ||
		(["unit", "tooling"].includes(value.lane) &&
			admission.state === "skipped" &&
			admission.reason === "supplemental_tests_skipped")
	requireFact(accepted, `invalid_${value.lane}_${admission.reason ?? admission.state}`)
	return { lane: value.lane, context: value.context, admission }
}

export function validatePackageEvidence(value, { expected, version, now = Date.now() }) {
	requireFact(
		typeof version === "string" && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(version),
		"invalid_release_version",
	)
	requireFact(
		value?.schemaVersion === 1 && value.kind === "alpha-release-package" && releaseTargets.includes(value.target),
		"invalid_package_bundle",
	)
	const [platform, arch] = value.target.split("-")
	validateJobContext(value.context, expected, "package-vsix", platform, now)
	requireFact(value.context.arch === arch, "wrong_native_architecture")
	requireFact(
		value.file === `alpha-${version}-${value.target}.vsix` &&
			sha(value.sha256) &&
			Number.isSafeInteger(value.size) &&
			value.size > 0 &&
			value.size <= 512 * 1024 * 1024,
		"invalid_package_identity",
	)
	const proof = value.build
	requireFact(
		proof?.status === "verified" &&
			proof.sourceTreeState === "clean" &&
			proof.sourceRevision === expected.source.commit &&
			["manifestDigest", "sourceTreeDigest", "artifactTreeDigest", "entrypointSha256", "packageJsonSha256"].every(
				(field) => sha(proof[field]),
			),
		"invalid_clean_build_provenance",
	)
	return value
}

async function fileIdentity(file) {
	const stat = await lstat(file)
	requireFact(
		stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 512 * 1024 * 1024,
		"invalid_package_file",
	)
	const hash = createHash("sha256")
	for await (const bytes of createReadStream(file)) hash.update(bytes)
	return { size: stat.size, sha256: hash.digest("hex") }
}

async function verifyPackageFiles(packages, directory, version) {
	requireFact(
		Array.isArray(packages) &&
			packages.length === releaseTargets.length &&
			new Set(packages.map((value) => value.target)).size === releaseTargets.length,
		"incomplete_package_matrix",
	)
	const files = (await readdir(directory)).filter((file) => file.toLowerCase().endsWith(".vsix")).sort()
	const expectedFiles = releaseTargets.map((target) => `alpha-${version}-${target}.vsix`).sort()
	requireFact(JSON.stringify(files) === JSON.stringify(expectedFiles), "unexpected_package_inventory")
	for (const value of packages) {
		requireFact(
			releaseTargets.includes(value.target) && value.file === `alpha-${version}-${value.target}.vsix`,
			"unexpected_package_name",
		)
		const identity = await fileIdentity(path.join(directory, value.file))
		requireFact(identity.sha256 === value.sha256 && identity.size === value.size, "changed_package_bytes")
	}
}

export async function aggregateReleaseEvidence({
	root,
	expected,
	validation,
	packages,
	needs,
	packageDirectory,
	version,
	now = Date.now(),
}) {
	const successfulNeeds = requireReleaseNeeds(needs)
	const lanes = Object.keys(releaseValidationPlatforms)
	requireFact(
		Array.isArray(validation) &&
			validation.length === lanes.length &&
			new Set(validation.map((value) => value.lane)).size === lanes.length,
		"incomplete_validation_matrix",
	)
	const { comparableSource } = await import("./source.mjs")
	// Native checkouts can differ in line endings. Preserve each raw content identity and compare within its host;
	// the clean commit and Git tree bind all platforms to the same source revision.
	const sourceByHost = new Map([[`${expected.platform}:${expected.arch}`, expected.source]])
	const bindSource = (context) => {
		const key = `${context.platform}:${context.arch}`
		const prior = sourceByHost.get(key)
		if (prior) requireFact(comparableSource(prior, context.source), "inconsistent_checkout_content")
		else sourceByHost.set(key, context.source)
	}
	const validated = []
	for (const value of validation) {
		validated.push(await validateValidationEvidence(value, { root, expected, now }))
		bindSource(value.context)
	}
	requireFact(
		lanes.every((lane) => validated.some((value) => value.lane === lane)),
		"missing_required_validation",
	)
	requireFact(Array.isArray(packages) && packages.length === releaseTargets.length, "incomplete_package_matrix")
	for (const value of packages) {
		validatePackageEvidence(value, { expected, version, now })
		bindSource(value.context)
	}
	await verifyPackageFiles(packages, packageDirectory, version)
	return {
		schemaVersion: 1,
		kind: "alpha-release-evidence",
		status: "passed",
		context: expected,
		needs: successfulNeeds,
		generatedAt: new Date(now).toISOString(),
		validation: validated,
		packages,
	}
}

async function save(root, output, value) {
	const file = path.resolve(root, output)
	const relative = path.relative(root, file)
	requireFact(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "output_outside_checkout")
	await mkdir(path.dirname(file), { recursive: true })
	await writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 })
}

async function recordValidation(root, lane, env) {
	requireFact(Object.hasOwn(releaseValidationPlatforms, lane), "unknown_release_lane")
	const [{ readHarnessReports }, { collectOutcomeBuild }] = await Promise.all([
		import("./matrix.mjs"),
		import("./outcome-proof.mjs"),
	])
	const reports = (await readHarnessReports(path.join(root, "artifacts/harness"))).filter(
		(report) => report.lane === lane,
	)
	requireFact(reports.length === 1, "missing_or_duplicate_lane_execution")
	const context = await collectContext(root, "validation", env)
	const value = {
		schemaVersion: 1,
		kind: "alpha-release-validation",
		lane,
		context,
		report: reports[0],
		...(lane === "outcomes" ? { outcomeBuild: await collectOutcomeBuild(root) } : {}),
	}
	await validateValidationEvidence(value, { root, expected: context })
	return value
}

async function recordPackage(root, target, file, env) {
	requireFact(releaseTargets.includes(target) && hostVsixTarget() === target, "non_native_package_runner")
	const context = await collectContext(root, "package-vsix", env)
	const { verifyExtensionBuildProvenance } = await import("../extension-build-provenance.mjs")
	const build = await verifyExtensionBuildProvenance({
		extensionPath: path.join(root, "src"),
		repositoryRoot: root,
		requireCleanSource: true,
	})
	const version = (await readJson(path.join(root, "src/package.json"))).value.version
	const value = {
		schemaVersion: 1,
		kind: "alpha-release-package",
		target,
		context,
		build,
		file: path.basename(file),
		...(await fileIdentity(file)),
	}
	validatePackageEvidence(value, { expected: context, version })
	return value
}

export async function verifyPublication({ root, report, packageDirectory, env = process.env, now = Date.now() }) {
	requireFact(
		env.GITHUB_ACTIONS === "true" &&
			env.GITHUB_JOB === "publish-release" &&
			id(env.GITHUB_RUN_ID) &&
			id(env.GITHUB_RUN_ATTEMPT),
		"publication_ci_identity_unavailable",
	)
	requireFact(
		report?.schemaVersion === 1 && report.kind === "alpha-release-evidence" && report.status === "passed",
		"publication_without_passing_barrier",
	)
	requireFact(
		sha(env.GITHUB_SHA, 40) &&
			(await git(root, ["rev-parse", "HEAD"])) === env.GITHUB_SHA &&
			report.context?.source?.commit === env.GITHUB_SHA &&
			report.context.gitTree === (await git(root, ["rev-parse", "HEAD^{tree}"])),
		"publication_source_mismatch",
	)
	requireFact(
		report.context.source.dirty === false &&
			sha(report.context.source.treeSha256) &&
			sha(report.context.source.lockfileSha256),
		"publication_unclean_source",
	)
	requireFact(
		report.context.ci?.runId === env.GITHUB_RUN_ID &&
			report.context.ci.runAttempt === env.GITHUB_RUN_ATTEMPT &&
			report.context.ci.job === "release-gate",
		"publication_run_mismatch",
	)
	requireFact(
		Number.isFinite(Date.parse(report.generatedAt)) &&
			now - Date.parse(report.generatedAt) <= ageLimit &&
			Date.parse(report.generatedAt) <= now + 60_000,
		"expired_publication_barrier",
	)
	requireReleaseNeeds(JSON.parse(env.RELEASE_NEEDS), true)
	requireReleaseNeeds(report.needs)
	const lanes = Object.keys(releaseValidationPlatforms)
	requireFact(
		Array.isArray(report.validation) &&
			report.validation.length === lanes.length &&
			lanes.every((lane) => report.validation.filter((value) => value.lane === lane).length === 1),
		"publication_validation_inventory_mismatch",
	)
	for (const value of report.validation) {
		validateJobContext(value.context, report.context, "validation", releaseValidationPlatforms[value.lane], now)
		requireFact(
			value.admission?.state === "executed-pass" ||
				(["unit", "tooling"].includes(value.lane) &&
					value.admission?.state === "skipped" &&
					value.admission.reason === "supplemental_tests_skipped"),
			"publication_validation_not_passed",
		)
	}
	const manifest = (await readJson(path.join(root, "package.json"))).value
	requireFact(
		report.context.node === manifest.engines.node && `pnpm@${report.context.pnpm}` === manifest.packageManager,
		"publication_toolchain_mismatch",
	)
	const version = (await readJson(path.join(root, "src/package.json"))).value.version
	for (const value of report.packages ?? [])
		validatePackageEvidence(value, { expected: report.context, version, now })
	await verifyPackageFiles(report.packages, packageDirectory, version)
	return { status: "passed", packages: releaseTargets.length, candidate: env.GITHUB_SHA }
}

export async function releaseEvidenceCli(args, { root = process.cwd(), env = process.env } = {}) {
	const [action, ...flags] = args
	const options = new Map()
	for (let index = 0; index < flags.length; index += 2) {
		requireFact(
			["--lane", "--target", "--vsix", "--output", "--validation-root", "--packages", "--input"].includes(
				flags[index],
			) &&
				!options.has(flags[index]) &&
				flags[index + 1] &&
				!flags[index + 1].startsWith("--"),
			"invalid_option",
		)
		options.set(flags[index], flags[index + 1])
	}
	const allowed = {
		"record-validation": ["--lane", "--output"],
		"record-package": ["--target", "--vsix", "--output"],
		aggregate: ["--validation-root", "--packages", "--output"],
		"verify-publication": ["--input", "--packages"],
	}[action]
	requireFact(
		allowed && options.size === allowed.length && allowed.every((flag) => options.has(flag)),
		"invalid_action_options",
	)
	let result
	try {
		if (action === "record-validation") result = await recordValidation(root, options.get("--lane"), env)
		else if (action === "record-package")
			result = await recordPackage(root, options.get("--target"), path.resolve(root, options.get("--vsix")), env)
		else if (action === "verify-publication")
			return verifyPublication({
				root,
				env,
				report: (await readJson(path.resolve(root, options.get("--input")), 8 * 1024 * 1024)).value,
				packageDirectory: path.resolve(root, options.get("--packages")),
			})
		else {
			requireReleaseNeeds(JSON.parse(env.RELEASE_NEEDS))
			const expected = await collectContext(root, "release-gate", env)
			const version = (await readJson(path.join(root, "src/package.json"))).value.version
			const directory = path.resolve(root, options.get("--validation-root"))
			const expectedDirectories = Object.keys(releaseValidationPlatforms)
				.map((lane) => `release-validation-${lane}-${env.GITHUB_RUN_ATTEMPT}`)
				.sort()
			requireFact(
				JSON.stringify((await readdir(directory)).sort()) === JSON.stringify(expectedDirectories),
				"unexpected_validation_artifacts",
			)
			const validation = await Promise.all(
				Object.keys(releaseValidationPlatforms).map(
					async (lane) =>
						(
							await readJson(
								path.join(
									directory,
									`release-validation-${lane}-${env.GITHUB_RUN_ATTEMPT}`,
									`release-validation-${lane}.json`,
								),
								8 * 1024 * 1024,
							)
						).value,
				),
			)
			const packageDirectory = path.resolve(root, options.get("--packages"))
			const packages = await Promise.all(
				releaseTargets.map(
					async (target) =>
						(await readJson(path.join(packageDirectory, `alpha-${version}-${target}.vsix.evidence.json`)))
							.value,
				),
			)
			result = await aggregateReleaseEvidence({
				root,
				expected,
				validation,
				packages,
				needs: JSON.parse(env.RELEASE_NEEDS),
				packageDirectory,
				version,
			})
		}
	} catch (error) {
		if (action !== "aggregate") throw error
		result = {
			schemaVersion: 1,
			kind: "alpha-release-evidence",
			status: "failed",
			failure: error.message?.startsWith("release_evidence:")
				? error.message
				: "release_evidence:unavailable_or_invalid_input",
		}
	}
	await save(root, options.get("--output"), result)
	return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	releaseEvidenceCli(process.argv.slice(2))
		.then((result) => {
			console.log(JSON.stringify({ status: result.status ?? "recorded", kind: result.kind ?? "verified" }))
			if (result.status === "failed") process.exitCode = 1
		})
		.catch((error) => {
			console.error(
				error.message?.startsWith("release_evidence:")
					? error.message
					: "release_evidence:unavailable_or_invalid_input",
			)
			process.exitCode = 1
		})
