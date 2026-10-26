import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import vm from "node:vm"

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

test("labeled evaluation campaigns rerun updated commits without dispatching for unrelated labels", () => {
	const config = workflow("evals.yml")
	for (const event of ["opened", "reopened", "ready_for_review", "labeled", "synchronize"])
		assert.ok(config.on.pull_request.types.includes(event), event)
	const condition = config.jobs.evals.if
	const selected = (event, action, labels = [], label = "") => {
		const expression = condition
			.replace("contains(github.event.pull_request.labels.*.name, 'evals')", String(labels.includes("evals")))
			.replaceAll("github.event_name", JSON.stringify(event))
			.replaceAll("github.event.action", JSON.stringify(action))
			.replaceAll("github.event.label.name", JSON.stringify(label))
		return vm.runInNewContext(expression, {}, { timeout: 100 })
	}
	assert.equal(selected("pull_request", "synchronize", ["evals"]), true)
	assert.equal(selected("pull_request", "reopened", ["evals"]), true)
	assert.equal(selected("pull_request", "labeled", ["evals"], "evals"), true)
	assert.equal(selected("pull_request", "synchronize", []), false)
	assert.equal(selected("pull_request", "labeled", ["evals", "bug"], "bug"), false)
	assert.equal(selected("workflow_dispatch", undefined), true)
	assert.match(config.name, /OpenAI/)
	const environment = config.jobs.evals.steps.find((step) => step.name === "Create environment")
	assert.equal(environment.env.OPENAI_API_KEY, "${{ secrets.OPENAI_API_KEY }}")
	assert.match(environment.run, /process\.exit\(1\)/)
	assert.doesNotMatch(environment.run, /test-key-for-build|\$\{\{ secrets\./)
	assert.ok(
		config.jobs.evals.steps.some((step) => step.if === "always()" && step.run.includes("rmSync('.env.local'")),
	)
})

test("service contracts use disposable local test storage and fail for missing execution or leaked containers", () => {
	const config = workflow("evaluation-contracts.yml")
	assert.ok(Object.hasOwn(config.on, "workflow_call"))
	assert.ok(config.on.schedule.length > 0)
	const job = config.jobs["evaluator-contracts"]
	assert.equal(job["runs-on"], "ubuntu-latest")
	assert.equal(job.env.NODE_ENV, "test")
	const database = new URL(job.env.DATABASE_URL)
	assert.equal(database.hostname, "localhost")
	assert.equal(database.pathname, "/evals_test")
	assert.equal(database.port, "5433")
	assert.equal(job.services.postgres.env.POSTGRES_DB, "evals_test")
	assert.deepEqual(job.services.postgres.ports, ["5433:5432"])
	assert.deepEqual(job.services.redis.ports, ["6380:6379"])
	assert.match(job.services.postgres.options, /pg_isready.*evals_test/)
	assert.match(job.services.redis.options, /redis-cli ping/)
	const readiness = command(job, "pnpm --filter @alpha-code/evals services:check")
	const migration = command(job, "pnpm --filter @alpha-code/evals db:test:migrate")
	const services = command(job, "pnpm harness run services")
	const infrastructure = command(job, "pnpm harness run infrastructure")
	for (const step of [readiness, migration, services, infrastructure]) assert.ok(step)
	assert.ok(job.steps.indexOf(readiness) < job.steps.indexOf(migration))
	assert.ok(job.steps.indexOf(migration) < job.steps.indexOf(services))
	const matrix = runs(job).find((step) => step.run.startsWith("pnpm harness matrix"))
	assert.equal(matrix.if, "always()")
	assert.match(matrix.run, /--require services --require infrastructure/)
	const cleanup = runs(job).find((step) => step.run.includes("docker ps --all --quiet"))
	assert.equal(cleanup.if, "always()")
	assert.match(cleanup.run, /--filter label=alpha\.evals\.run-id/)
	assert.match(cleanup.run, /docker rm --force \$containers/)
	assert.match(cleanup.run, /exit 1/)
	assert.ok(job.steps.every((step) => step["continue-on-error"] !== true))
	assert.ok(job.steps.some((step) => step.if === "always()" && step.uses === "actions/upload-artifact@v6"))
})

test("QA and releases require service contracts and bounded rendered acceptance", () => {
	const qa = workflow("code-qa.yml")
	const release = workflow("release-vsix.yml")
	for (const config of [qa, release]) {
		assert.equal(config.jobs["evaluator-contracts"].uses, "./.github/workflows/evaluation-contracts.yml")
		assert.equal(config.permissions.contents, "read")
		assert.ok(Object.values(config.jobs).some((job) => job.steps && command(job, "pnpm harness run rendered")))
		assert.ok(
			Object.values(config.jobs).some((job) =>
				job.steps?.some((step) => step.if === "always()" && step.run?.includes("--require rendered")),
			),
		)
	}
	assert.equal(release.jobs["release-vsix"].needs, "evaluator-contracts")
	assert.equal(release.jobs["package-vsix"].needs, "release-vsix")
	assert.equal(release.jobs["publish-release"].needs, "package-vsix")
	const acceptance = release.jobs["release-vsix"]
	assert.ok(command(acceptance, "pnpm harness run stress"))
	assert.ok(acceptance.steps.some((step) => step.if === "always()" && step.run?.includes("--require stress")))
})

test("live admission is explicit and source-bound without provisioning or launching a paid provider", () => {
	const imported = workflow("live-evidence-policy.yml")
	for (const name of ["evidence_run_id", "model_id", "effort"])
		assert.equal(imported.on.workflow_dispatch.inputs[name].required, true)
	const job = imported.jobs["live-evidence-admission"]
	assert.equal(imported.permissions.actions, "read")
	const download = job.steps.find((step) => step.uses === "actions/download-artifact@v7")
	assert.equal(download.with.name, "alpha-live-copilot-evidence")
	assert.equal(download.with["run-id"], "${{ inputs.evidence_run_id }}")
	assert.equal(download.with.path, "${{ runner.temp }}/alpha-live-import")
	const admit = command(job, "node scripts/ci-live-evidence-policy.mjs")
	assert.equal(admit.if, "always()")
	assert.equal(admit.env.ALPHA_LIVE_EVAL_MODEL_ID, "${{ inputs.model_id }}")
	assert.equal(admit.env.ALPHA_LIVE_EVAL_EFFORT, "${{ inputs.effort }}")
	assert.ok(runs(job).every((step) => !/test:live|--provider live-copilot|--setup/.test(step.run)))
	const release = workflow("release-vsix.yml").jobs["release-vsix"]
	const conditional = command(release, "node scripts/ci-live-evidence-policy.mjs")
	assert.equal(conditional.if, "always() && vars.ALPHA_REQUIRE_LIVE_EVIDENCE == 'true'")
	assert.equal(conditional["continue-on-error"], undefined)
	const sidecar = runs(release).find((step) => step.run.includes("prepareLiveSidecar()"))
	assert.ok(release.steps.indexOf(sidecar) < release.steps.indexOf(command(release, "pnpm harness run outcomes")))
	assert.ok(
		release.steps.indexOf(command(release, "pnpm harness run stress")) <
			release.steps.indexOf(command(release, "pnpm harness run outcomes")),
	)
	assert.ok(
		release.steps.some(
			(step) => step.if === "vars.ALPHA_REQUIRE_LIVE_EVIDENCE != 'true'" && step.run?.includes("not requested"),
		),
	)
})
