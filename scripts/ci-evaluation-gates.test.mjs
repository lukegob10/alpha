import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const { parse } = createRequire(new URL("../packages/evals/package.json", import.meta.url))("yaml")
const workflow = (name) => parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"))
const runs = (job) => job.steps.filter((step) => typeof step.run === "string")
const command = (job, expected) => runs(job).find((step) => step.run === expected)

test("runner state is not referenced in workflow or job environment expressions", () => {
	for (const file of readdirSync(new URL("../.github/workflows/", import.meta.url))) {
		if (!/\.ya?ml$/u.test(file)) continue
		const config = workflow(file)
		const runnerExpression = /\$\{\{[^}]*\brunner\s*(?:\.|\[)/u
		assert.doesNotMatch(JSON.stringify(config.env ?? {}), runnerExpression, `${file}: env`)
		for (const [jobId, job] of Object.entries(config.jobs ?? {})) {
			assert.doesNotMatch(JSON.stringify(job.env ?? {}), runnerExpression, `${file}: jobs.${jobId}.env`)
		}
	}
})

test("Windows acceptance jobs configure runner-owned temporary directories before other steps", () => {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "alpha-ci-tempenv-")))
	try {
		const jobs = [
			...Object.values(workflow("code-qa.yml").jobs).filter((job) => job["runs-on"] === "windows-latest"),
			workflow("release-vsix.yml").jobs["release-vsix"],
		]
		const runnerTemp = path.join(root, "runner temp with spaces")
		for (const [index, job] of jobs.entries()) {
			const setup = job.steps[0]
			assert.equal(setup.shell, "pwsh", job.name)
			const environmentFile = path.join(root, `environment-${index}.txt`)
			const result = spawnSync(
				process.platform === "win32" ? "pwsh.exe" : "pwsh",
				["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", setup.run],
				{
					env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_ENV: environmentFile },
					encoding: "utf8",
					timeout: 20_000,
					windowsHide: true,
				},
			)
			assert.ifError(result.error)
			assert.equal(result.status, 0, result.stderr)
			assert.deepEqual(readFileSync(environmentFile, "utf8").trim().split(/\r?\n/u), [
				`TEMP=${runnerTemp}`,
				`TMP=${runnerTemp}`,
			])
		}
	} finally {
		assert.equal(path.dirname(root), realpathSync(os.tmpdir()))
		assert.match(path.basename(root), /^alpha-ci-tempenv-/u)
		rmSync(root, { recursive: true, force: true })
	}
})

test("workflow job dependencies and local reusable workflows resolve", () => {
	const files = readdirSync(new URL("../.github/workflows/", import.meta.url)).filter((file) =>
		/\.ya?ml$/u.test(file),
	)
	for (const file of files) {
		const config = workflow(file)
		for (const [jobId, job] of Object.entries(config.jobs)) {
			const dependencies = Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : []
			for (const dependency of dependencies)
				assert.ok(Object.hasOwn(config.jobs, dependency), `${file}: ${jobId} needs missing job ${dependency}`)
			if (job.uses?.startsWith("./.github/workflows/"))
				assert.ok(
					files.includes(job.uses.slice("./.github/workflows/".length)),
					`${file}: ${jobId} uses missing workflow ${job.uses}`,
				)
		}
	}
})

test("QA and releases require offline evaluator checks and bounded rendered acceptance", () => {
	const qa = workflow("code-qa.yml")
	const release = workflow("release-vsix.yml")
	for (const config of [qa, release]) {
		assert.equal(config.permissions.contents, "read")
		assert.ok(Object.values(config.jobs).some((job) => job.steps && command(job, "pnpm harness run offline")))
		assert.ok(Object.values(config.jobs).some((job) => job.steps && command(job, "pnpm harness run rendered")))
		assert.ok(
			Object.values(config.jobs).some((job) =>
				job.steps?.some((step) => step.if === "always()" && step.run?.includes("--require rendered")),
			),
		)
	}
	assert.equal(release.jobs["package-vsix"].needs, "release-vsix")
	assert.equal(release.jobs["publish-release"].needs, "package-vsix")
	const acceptance = release.jobs["release-vsix"]
	assert.ok(command(acceptance, "pnpm harness run stress"))
	assert.ok(acceptance.steps.some((step) => step.if === "always()" && step.run?.includes("--require stress")))
	assert.ok(
		acceptance.steps.indexOf(command(acceptance, "pnpm harness run stress")) <
			acceptance.steps.indexOf(command(acceptance, "pnpm harness run outcomes")),
	)
})

test("release publishing rejects existing remote tags that identify another source commit", async (t) => {
	const job = workflow("release-vsix.yml").jobs["publish-release"]
	const verify = job.steps.find((step) => step.name === "Verify release tag source")
	const publish = job.steps.find((step) => step.name === "Create GitHub release")
	assert.equal(verify?.shell, "pwsh")
	assert.equal(verify.env.ALPHA_RELEASE_SHA, "${{ github.sha }}")
	assert.ok(job.steps.indexOf(verify) < job.steps.indexOf(publish))

	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "alpha-release-tag-")))
	const source = path.join(root, "source with spaces")
	const remote = path.join(root, "remote.git")
	const git = (args, options = {}) => {
		const result = spawnSync("git", args, {
			cwd: source,
			encoding: "utf8",
			timeout: 20_000,
			windowsHide: true,
			...options,
		})
		assert.ifError(result.error)
		assert.equal(result.status, 0, result.stderr)
		return result.stdout.trim()
	}
	try {
		mkdirSync(source)
		git(["init", "--bare", remote])
		git(["init"])
		git(["config", "user.name", "Release test"])
		git(["config", "user.email", "release-test@example.invalid"])
		git(["config", "core.hooksPath", path.join(root, "no-hooks")])
		writeFileSync(path.join(source, "fixture.txt"), "first\n")
		git(["add", "fixture.txt"])
		git(["commit", "-m", "First source"])
		const previous = git(["rev-parse", "HEAD"])
		writeFileSync(path.join(source, "fixture.txt"), "second\n")
		git(["commit", "-am", "Release source"])
		const expected = git(["rev-parse", "HEAD"])
		git(["remote", "add", "origin", remote])
		git(["push", "origin", "HEAD:refs/heads/main"])
		mkdirSync(path.join(source, "src"))
		const cases = [
			{ name: "absent tag", mode: "absent", target: expected, accepted: true },
			{ name: "matching lightweight tag", mode: "lightweight", target: expected, accepted: true },
			{ name: "matching annotated tag", mode: "annotated", target: expected, accepted: true },
			{ name: "mismatched lightweight tag", mode: "lightweight", target: previous, accepted: false },
			{ name: "mismatched annotated tag", mode: "annotated", target: previous, accepted: false },
			{ name: "unreachable remote", mode: "unreachable", target: expected, accepted: false },
		]
		for (const [index, entry] of cases.entries()) {
			await t.test(entry.name, () => {
				const version = `3.2.${index}`
				writeFileSync(path.join(source, "src/package.json"), JSON.stringify({ version }))
				const tag = `vsix-v${version}-${expected.slice(0, 7)}`
				if (entry.mode === "lightweight") git(["tag", tag, entry.target])
				if (entry.mode === "annotated") git(["tag", "-a", tag, entry.target, "-m", "Release test tag"])
				if (["lightweight", "annotated"].includes(entry.mode)) git(["push", "origin", `refs/tags/${tag}`])
				if (entry.mode === "unreachable") git(["remote", "set-url", "origin", path.join(root, "missing.git")])
				const result = spawnSync(
					process.platform === "win32" ? "pwsh.exe" : "pwsh",
					["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", verify.run],
					{
						cwd: source,
						env: { ...process.env, ALPHA_RELEASE_SHA: expected },
						encoding: "utf8",
						timeout: 20_000,
						windowsHide: true,
					},
				)
				assert.ifError(result.error)
				if (entry.accepted) assert.equal(result.status, 0, result.stderr)
				else {
					assert.notEqual(result.status, 0, entry.name)
					assert.match(result.stderr, /Release tag|remote release tag/)
				}
			})
		}
	} finally {
		assert.equal(path.dirname(root), realpathSync(os.tmpdir()))
		assert.match(path.basename(root), /^alpha-release-tag-/u)
		rmSync(root, { recursive: true, force: true })
	}
})
