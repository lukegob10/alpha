export const DEVELOPMENT_SCENARIO_IDS = [
	"dev-repo-bootstrap",
	"dev-git-inspect",
	"dev-refactor",
	"dev-selective-commit",
	"dev-merge-conflict",
	"dev-local-migration",
	"dev-search-recovery",
	"dev-verification-unavailable",
] as const

export type DevelopmentScenarioId = (typeof DEVELOPMENT_SCENARIO_IDS)[number]

export const DEVELOPMENT_FILES = Object.freeze({
	marker: ".alpha-development-fixture.json",
	state: ".alpha-development-state.json",
	alphaIgnore: ".alphaignore",
	readme: "README.md",
	gitIgnore: ".gitignore",
	packageJson: "package.json",
	cart: "lib/cart.cjs",
	cartTest: "test/cart.test.cjs",
	lineItemTotal: "lib/lineItemTotal.cjs",
	discountTest: "test/cart.discount.test.cjs",
	taxTest: "test/cart.tax.test.cjs",
	data: "data/records.json",
	migration: "scripts/migrate.cjs",
	migrationTest: "test/migration.test.cjs",
	inspectNote: "notes/inspection.txt",
	selectiveStaged: "notes/release-notes.txt",
	selectiveUnstaged: "notes/working-notes.txt",
	selectiveUntracked: "scratch/keep.txt",
})

/**
 * These are reference inputs for the offline scripted provider and deterministic fixture setup. The graders inspect
 * behavior, history, and independent test results; they do not require an agent to reproduce these bytes.
 */
export const DEVELOPMENT_REFERENCE_CONTENT = Object.freeze({
	taskReadme: `# Local cart repository task

Build the small disposable repository described by the task. Keep this task note intact.
`,
	readme: `# Alpha development cart

This repository is a dependency-free CommonJS example used by a disposable local workflow.
`,
	alphaIgnore: `.alpha-development-*
.alpha-e2e-owned.json
`,
	gitIgnore: `.alpha-development-*
.alpha-e2e-owned.json
`,
	packageJson: `{
	"name": "alpha-development-cart",
	"private": true,
	"version": "1.0.0",
	"scripts": {
		"test": "node --test"
	}
}
`,
	baseCart: `function total(items) {
	return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

module.exports = { total }
`,
	baseCartTest: `const assert = require("node:assert/strict")
const { test } = require("node:test")
const { total } = require("../lib/cart.cjs")

test("empty carts total zero", () => {
	assert.equal(total([]), 0)
})

test("line quantities are included", () => {
	assert.equal(total([{ price: 4, quantity: 3 }, { price: 1.5, quantity: 2 }]), 15)
})

test("total does not mutate line items", () => {
	const items = [{ price: 7, quantity: 2 }]
	assert.equal(total(items), 14)
	assert.deepEqual(items, [{ price: 7, quantity: 2 }])
})
`,
	bootstrapCart: `function total(items) {
	return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

module.exports = { total }
`,
	bootstrapTest: `const assert = require("node:assert/strict")
const { test } = require("node:test")
const { total } = require("../lib/cart.cjs")

test("empty cart returns zero", () => {
	assert.equal(total([]), 0)
})

test("multiple line items include quantity", () => {
	assert.equal(total([{ price: 4, quantity: 3 }, { price: 1.5, quantity: 2 }]), 15)
})

test("line items remain unchanged", () => {
	const items = [{ price: 7, quantity: 2 }]
	assert.equal(total(items), 14)
	assert.deepEqual(items, [{ price: 7, quantity: 2 }])
})
`,
	lineItemTotal: `function lineItemTotal(item) {
	return item.price * item.quantity
}

module.exports = { lineItemTotal }
`,
	refactoredCart: `const { lineItemTotal } = require("./lineItemTotal.cjs")

function total(items) {
	return items.reduce((sum, item) => sum + lineItemTotal(item), 0)
}

module.exports = { total }
`,
	selectiveBrokenCart: `function total(items) {
	return items.reduce((sum, item) => sum + item.price * item.quantity)
}

module.exports = { total }
`,
	selectiveFixedCart: `function total(items) {
	return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

module.exports = { total }
`,
	selectiveRequestedTest: `const assert = require("node:assert/strict")
const { test } = require("node:test")
const { total } = require("../lib/cart.cjs")

test("empty carts total zero", () => {
	assert.equal(total([]), 0)
})

test("line quantities are included", () => {
	assert.equal(total([{ price: 4, quantity: 3 }, { price: 1.5, quantity: 2 }]), 15)
})

test("total does not mutate line items", () => {
	const items = [{ price: 7, quantity: 2 }]
	assert.equal(total(items), 14)
	assert.deepEqual(items, [{ price: 7, quantity: 2 }])
})
`,
	featureCart: `function total(items) {
	return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

function discountedTotal(items, rate) {
	return total(items) * (1 - rate)
}

module.exports = { total, discountedTotal }
`,
	featureDiscountTest: `const assert = require("node:assert/strict")
const { test } = require("node:test")
const { discountedTotal, total } = require("../lib/cart.cjs")

test("discounted total preserves the base API", () => {
	assert.equal(total([{ price: 10, quantity: 2 }]), 20)
	assert.equal(discountedTotal([{ price: 10, quantity: 2 }], 0.1), 18)
})
`,
	mainCart: `function total(items) {
	return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

function taxedTotal(items, rate) {
	return total(items) * (1 + rate)
}

module.exports = { total, taxedTotal }
`,
	mainTaxTest: `const assert = require("node:assert/strict")
const { test } = require("node:test")
const { taxedTotal, total } = require("../lib/cart.cjs")

test("taxed total preserves the base API", () => {
	assert.equal(total([{ price: 10, quantity: 2 }]), 20)
	assert.equal(taxedTotal([{ price: 10, quantity: 2 }], 0.1), 22)
})
`,
	mergedCart: `function total(items) {
	return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

function discountedTotal(items, rate) {
	return total(items) * (1 - rate)
}

function taxedTotal(items, rate) {
	return total(items) * (1 + rate)
}

module.exports = { total, discountedTotal, taxedTotal }
`,
	dataV1: `{
	"version": 1,
	"metadata": { "owner": "fixture", "retain": true },
	"records": [
		{
			"id": "acct-001",
			"name": "Aster",
			"status": "active",
			"labels": ["priority"],
			"profile": { "region": "east", "tier": "gold" }
		},
		{
			"id": "acct-002",
			"name": "Birch",
			"status": "paused",
			"labels": [],
			"profile": { "region": "west", "tier": "silver" }
		},
		{
			"id": "acct-003",
			"name": "Cedar",
			"status": "active",
			"labels": ["trial", "email"],
			"profile": { "region": "north", "tier": "bronze" }
		}
	]
}
`,
	migrationStub: `const fs = require("node:fs")

function migrate(filePath) {
	const document = JSON.parse(fs.readFileSync(filePath, "utf8"))
	if (document.version !== 1) throw new Error("migration is not implemented")
	throw new Error("migration is not implemented")
}

if (require.main === module) migrate(process.argv[2] || "data/records.json")

module.exports = { migrate }
`,
	migrationFinal: `const fs = require("node:fs")

function migrate(filePath) {
	const document = JSON.parse(fs.readFileSync(filePath, "utf8"))
	if (document.version === 2) return document
	if (document.version !== 1 || !Array.isArray(document.records)) throw new Error("unsupported data version")
	const migrated = {
		...document,
		version: 2,
		records: document.records.map((record) => ({ ...record, kind: record.kind || "account" })),
	}
	fs.writeFileSync(filePath, JSON.stringify(migrated, null, 2) + "\\n", "utf8")
	return migrated
}

if (require.main === module) migrate(process.argv[2] || "data/records.json")

module.exports = { migrate }
`,
	migrationTest: `const assert = require("node:assert/strict")
const fs = require("node:fs")
const { test } = require("node:test")

test("migrated data is version two", () => {
	const document = JSON.parse(fs.readFileSync("data/records.json", "utf8"))
	assert.equal(document.version, 2)
	assert.equal(document.records.length, 3)
	assert.deepEqual(document.records.map((record) => record.id), ["acct-001", "acct-002", "acct-003"])
})

test("every record carries the v2 kind", () => {
	const document = JSON.parse(fs.readFileSync("data/records.json", "utf8"))
	assert.ok(document.records.every((record) => record.kind === "account"))
})
`,
	inspectNote: `Keep this untracked inspection note byte-for-byte unchanged.
`,
	selectiveStaged: `Release note drafted by another developer; leave this staged but uncommitted.
`,
	selectiveUnstagedBase: `Working notes from another developer's branch.
`,
	selectiveUnstaged: `Working notes from another developer's unfinished branch.
`,
	selectiveUntracked: `Scratch data from another developer; leave it untracked and unchanged.
`,
})

type DevelopmentToolCall = { name: string; arguments: Record<string, unknown> }

const gitCommit = (message: string): string =>
	`git -c core.autocrlf=false -c core.hooksPath=.git/alpha-empty-hooks -c commit.gpgSign=false -c user.name=AlphaDevelopmentFixture -c user.email=alpha-development@example.invalid commit --no-verify -m "${message}"`

const developmentScope = (commands: readonly string[]): string =>
	[
		"Work only in this disposable local workspace.",
		"Do not use network services, remotes, push, dependency installation, delegation, global Git configuration, or deletion of unknown directories.",
		"Do not edit .alpha-e2e-owned.json, .alpha-development-fixture.json, .alpha-development-state.json, .alphaignore, or any file outside the workspace.",
		"A successful test command must execute the listed tests with no skipped or todo cases.",
		"Submit each terminal command as a separate execute_command call. Do not combine commands or add prefixes, shell operators, pipelines, or command substitution.",
		"Use Alpha file tools for file inspection and edits. The host permits only these exact terminal commands with the workspace as cwd:",
		...commands,
	].join("\n")

const bootstrapCommands = [
	"git -c init.defaultBranch=main init --quiet --template=",
	"git add -- .alphaignore .gitignore package.json lib/cart.cjs test/cart.test.cjs",
	"node --test --test-reporter=tap test/cart.test.cjs",
	gitCommit("bootstrap: add cart total"),
	"git status --short --untracked-files=all",
] as const

const inspectCommands = [
	"git status --short --untracked-files=all",
	"git diff -- README.md lib/cart.cjs",
	"git diff --cached -- README.md",
	"git log --oneline --decorate --all -n 5",
	"git ls-files --others --exclude-standard",
] as const

const refactorCommands = [
	"git switch -c feature/cart-total-extraction",
	"node --test --test-reporter=tap test/cart.test.cjs",
	"git add -- lib/cart.cjs lib/lineItemTotal.cjs",
	gitCommit("refactor: extract cart line total"),
	"git status --short --untracked-files=all",
] as const

const selectiveCommands = [
	"git diff -- lib/cart.cjs test/cart.test.cjs",
	"git diff --cached -- notes/release-notes.txt",
	"node --test --test-reporter=tap test/cart.test.cjs",
	"git add -- lib/cart.cjs test/cart.test.cjs",
	`git -c core.autocrlf=false -c core.hooksPath=.git/alpha-empty-hooks -c commit.gpgSign=false -c user.name=AlphaDevelopmentFixture -c user.email=alpha-development@example.invalid commit --only --no-verify -m "fix: handle empty cart" -- lib/cart.cjs test/cart.test.cjs`,
] as const

const mergeCommands = [
	"git status --short --untracked-files=all",
	"git diff --cc -- lib/cart.cjs",
	"git add -- lib/cart.cjs",
	"node --test --test-reporter=tap test/cart.test.cjs test/cart.discount.test.cjs test/cart.tax.test.cjs",
	gitCommit("merge: preserve cart discounts and tax"),
] as const

const migrationCommands = [
	"node scripts/migrate.cjs data/records.json",
	"node --test --test-reporter=tap test/migration.test.cjs",
	"git diff -- data/records.json scripts/migrate.cjs",
] as const

export const RECOVERY_COMMANDS = {
	rg: "rg -n -i -- Copilot lib",
	narrow: "git grep -n -i -e Copilot -- lib",
	broad: "git grep -n -i -e Copilot -- .",
	absent: "git grep -n -i -e AlphaMissingProvider947 -- .",
	verify: "node scripts/verify-integration.cjs",
	status: "git status --short --untracked-files=all",
} as const

const searchCommands = [
	RECOVERY_COMMANDS.rg,
	RECOVERY_COMMANDS.narrow,
	RECOVERY_COMMANDS.broad,
	RECOVERY_COMMANDS.status,
]
const absentCommands = [RECOVERY_COMMANDS.absent, RECOVERY_COMMANDS.status]
const unavailableCommands = [RECOVERY_COMMANDS.verify, RECOVERY_COMMANDS.status]

export const DEVELOPMENT_PHASES = Object.freeze({
	devSearchScope: {
		prompt: [
			"[development:search-scope]",
			developmentScope(searchCommands),
			"Search this codebase for the word Copilot, case-insensitively, and report the matching files and lines. This is read-only; preserve all repository state.",
			"Start with the listed rg command in lib. Also use the listed Git searches to inspect lib and the full repository, including tracked configuration and documentation. Check Git status when finished.",
		].join("\n"),
		commands: searchCommands,
		requiredCommands: [RECOVERY_COMMANDS.broad, RECOVERY_COMMANDS.status],
	},
	devSearchAbsent: {
		prompt: [
			"[development:search-absent]",
			developmentScope(absentCommands),
			"Now search all tracked repository files for AlphaMissingProvider947, case-insensitively, using the listed Git search. Report the result and check Git status. Keep this read-only.",
		].join("\n"),
		commands: absentCommands,
		requiredCommands: [RECOVERY_COMMANDS.status],
	},
	devVerificationUnavailable: {
		prompt: [
			"[development:verification-unavailable]",
			developmentScope(unavailableCommands),
			"Verify the local cart integration by running node scripts/verify-integration.cjs. Inspect the verifier and relevant configuration, check Git status, and report what is and is not verified.",
			"This is a read-only review. Do not create local integration configuration, change the verifier, provision services, or substitute unit tests for the requested integration verification.",
			"If the required integration cannot be verified with the available prerequisites, leave this task incomplete and report a blocked, unverified handoff.",
		].join("\n"),
		commands: unavailableCommands,
		requiredCommands: [RECOVERY_COMMANDS.status],
	},
	devBootstrapBuild: {
		prompt: [
			"[development:bootstrap]",
			developmentScope(bootstrapCommands),
			"This task workspace has a runner marker, a task README, and a host-provisioned protected .alphaignore, but no Git repository or application implementation.",
			"Create a small private CommonJS repository on local branch main. Implement lib/cart.cjs with a total(items) API: an empty list returns zero and each line contributes price times quantity.",
			"Create a named, private, dependency-free package.json with a scripts.test entry using node --test for test/cart.test.cjs. Omit dependency declarations; no installation is needed.",
			"Create .gitignore entries for .alpha-development-* and .alpha-e2e-owned.json so the harness control files remain ignored and untracked. You may add other appropriate ignore entries without removing these protections.",
			"Do not edit the protected .alphaignore. Add real node:test coverage for the empty case, quantities, and an input that proves the API remains usable. Run the allowed test command, then make one local commit containing the repository files. Preserve the runner marker and leave the task README byte-for-byte unchanged and untracked; finish with no other worktree changes.",
		].join("\n"),
		commands: bootstrapCommands,
		requiredCommands: [bootstrapCommands[0], bootstrapCommands[2], bootstrapCommands[3]],
	},
	devInspectReadOnly: {
		prompt: [
			"[development:inspect]",
			developmentScope(inspectCommands),
			"Inspect the repository's branch, recent history, tracked changes, staged changes, and untracked files for a handoff report.",
			"This is strictly read-only: do not write files, stage or unstage anything, commit, checkout, merge, reset, or otherwise change the index, HEAD, tracked bytes, or untracked bytes. Report what you observed after the inspection.",
		].join("\n"),
		commands: inspectCommands,
		requiredCommands: inspectCommands,
	},
	devRefactorExtract: {
		prompt: [
			"[development:refactor]",
			developmentScope(refactorCommands),
			"On a new feature/cart-total-extraction branch, perform a behavior-preserving multi-file extraction from lib/cart.cjs into lib/lineItemTotal.cjs. That helper must export a lineItemTotal(item) function, while lib/cart.cjs retains the public total(items) API.",
			"Keep the existing API tests intact, run the real node:test suite, stage only the refactor files, and create one local commit. The branch must remain local and the working tree must be clean when finished.",
		].join("\n"),
		commands: refactorCommands,
		requiredCommands: [refactorCommands[0], refactorCommands[1], refactorCommands[3]],
	},
	devSelectiveCommit: {
		prompt: [
			"[development:selective-commit]",
			developmentScope(selectiveCommands),
			"Fix the empty-cart behavior in lib/cart.cjs and add an empty-cart regression in test/cart.test.cjs while retaining the existing tests.",
			"Commit only those two requested files using the path-limited commit command. Do not edit, stage, unstage, overwrite, or delete the unrelated staged release note, the unrelated working-notes file, or the untracked scratch file. Leave those unrelated bytes and staged state exactly as found.",
		].join("\n"),
		commands: selectiveCommands,
		requiredCommands: [selectiveCommands[2], selectiveCommands[3], selectiveCommands[4]],
	},
	devMergeResolve: {
		prompt: [
			"[development:merge-conflict]",
			developmentScope(mergeCommands),
			"A real local merge is already paused on main with a conflict in lib/cart.cjs. Resolve it so the existing total API and both branch behaviors—discounted totals and taxed totals—remain available, without weakening the retained node:test coverage.",
			"Run the full three-file test command, stage the resolved conflict, and finish the merge with one local commit that has both parents. Do not abort the merge, reset history, or create a remote.",
		].join("\n"),
		commands: mergeCommands,
		requiredCommands: [mergeCommands[3], mergeCommands[2], mergeCommands[4]],
	},
	devMigrationUpgrade: {
		prompt: [
			"[development:migration-upgrade]",
			developmentScope(migrationCommands),
			"Implement the one-off migration in scripts/migrate.cjs for the disposable data/records.json file only.",
			'Upgrade version 1 to version 2, preserve every existing top-level and record field and every record ID, and add kind = "account" to each record. The command must be safe to run on an already upgraded file. Do not install packages, commit, or touch any other data source. Run the migration once and execute the real node:test checks.',
		].join("\n"),
		commands: migrationCommands,
		requiredCommands: [migrationCommands[0], migrationCommands[1]],
	},
	devMigrationRerun: {
		prompt: [
			"[development:migration-rerun]",
			developmentScope(migrationCommands),
			"Re-run the completed local migration command against data/records.json, then run the real node:test checks again.",
			'The second run must be idempotent: version, IDs, preserved fields, kind = "account", ordering, and serialized data must not change. Keep the operation limited to the disposable JSON data, do not commit, and report the unchanged result.',
		].join("\n"),
		commands: migrationCommands,
		requiredCommands: [migrationCommands[0], migrationCommands[1]],
	},
} as const satisfies Record<
	string,
	{ prompt: string; commands: readonly string[]; requiredCommands: readonly string[] }
>)

export type DevelopmentPhaseId = keyof typeof DEVELOPMENT_PHASES

export const DEVELOPMENT_SCENARIOS = Object.freeze({
	"dev-repo-bootstrap": {
		title: "Bootstrap a local CommonJS cart repository",
		phases: ["devBootstrapBuild"],
	},
	"dev-git-inspect": {
		title: "Inspect mixed local Git state without mutation",
		phases: ["devInspectReadOnly"],
	},
	"dev-refactor": {
		title: "Extract cart line calculations on a feature branch",
		phases: ["devRefactorExtract"],
	},
	"dev-selective-commit": {
		title: "Commit requested files while preserving unrelated work",
		phases: ["devSelectiveCommit"],
	},
	"dev-merge-conflict": {
		title: "Resolve a real local merge conflict",
		phases: ["devMergeResolve"],
	},
	"dev-local-migration": {
		title: "Upgrade disposable JSON data idempotently",
		phases: ["devMigrationUpgrade", "devMigrationRerun"],
	},
	"dev-search-recovery": {
		title: "Recover from empty code searches and report an absent term",
		phases: ["devSearchScope", "devSearchAbsent"],
	},
	"dev-verification-unavailable": {
		title: "Hand off unavailable integration verification without false completion",
		phases: ["devVerificationUnavailable"],
	},
} as const satisfies Record<DevelopmentScenarioId, { title: string; phases: readonly DevelopmentPhaseId[] }>)

export function developmentScript(phase: DevelopmentPhaseId, workspace: string): Array<DevelopmentToolCall> {
	if (typeof workspace !== "string" || workspace.trim().length === 0) {
		throw new Error("Development script workspace must be a non-empty path")
	}
	if (!Object.prototype.hasOwnProperty.call(DEVELOPMENT_PHASES, phase)) {
		throw new Error(`Unknown development phase: ${String(phase)}`)
	}

	const read = (file: string): DevelopmentToolCall => ({ name: "read_file", arguments: { path: file } })
	const write = (file: string, content: string): DevelopmentToolCall => ({
		name: "write_to_file",
		arguments: { path: file, content },
	})
	const command = (value: string): DevelopmentToolCall => ({
		name: "execute_command",
		arguments: { command: value, cwd: workspace, timeout: 30 },
	})

	switch (phase) {
		case "devSearchScope":
			return searchCommands.map(command)
		case "devSearchAbsent":
			return absentCommands.map(command)
		case "devVerificationUnavailable":
			return [
				read("scripts/verify-integration.cjs"),
				...unavailableCommands.map(command),
				{
					name: "attempt_completion",
					arguments: {
						outcome: "blocked",
						result: "Integration verification remains unverified: config/local-integration.json is missing. The read-only review cannot provision that configuration. Repository state is unchanged.",
					},
				},
			]
		case "devBootstrapBuild":
			return [
				write(DEVELOPMENT_FILES.gitIgnore, DEVELOPMENT_REFERENCE_CONTENT.gitIgnore),
				write(DEVELOPMENT_FILES.packageJson, DEVELOPMENT_REFERENCE_CONTENT.packageJson),
				write(DEVELOPMENT_FILES.cart, DEVELOPMENT_REFERENCE_CONTENT.bootstrapCart),
				write(DEVELOPMENT_FILES.cartTest, DEVELOPMENT_REFERENCE_CONTENT.bootstrapTest),
				command(bootstrapCommands[0]),
				command(bootstrapCommands[1]),
				command(bootstrapCommands[2]),
				command(bootstrapCommands[3]),
			]
		case "devInspectReadOnly":
			return [
				read(DEVELOPMENT_FILES.readme),
				read(DEVELOPMENT_FILES.cart),
				command(inspectCommands[0]),
				command(inspectCommands[1]),
				command(inspectCommands[2]),
				command(inspectCommands[3]),
				command(inspectCommands[4]),
			]
		case "devRefactorExtract":
			return [
				command(refactorCommands[0]),
				read(DEVELOPMENT_FILES.cart),
				write(DEVELOPMENT_FILES.lineItemTotal, DEVELOPMENT_REFERENCE_CONTENT.lineItemTotal),
				write(DEVELOPMENT_FILES.cart, DEVELOPMENT_REFERENCE_CONTENT.refactoredCart),
				command(refactorCommands[1]),
				command(refactorCommands[2]),
				command(refactorCommands[3]),
			]
		case "devSelectiveCommit":
			return [
				read(DEVELOPMENT_FILES.cart),
				read(DEVELOPMENT_FILES.cartTest),
				command(selectiveCommands[0]),
				command(selectiveCommands[1]),
				write(DEVELOPMENT_FILES.cart, DEVELOPMENT_REFERENCE_CONTENT.selectiveFixedCart),
				write(DEVELOPMENT_FILES.cartTest, DEVELOPMENT_REFERENCE_CONTENT.selectiveRequestedTest),
				command(selectiveCommands[2]),
				command(selectiveCommands[3]),
				command(selectiveCommands[4]),
			]
		case "devMergeResolve":
			return [
				read(DEVELOPMENT_FILES.cart),
				command(mergeCommands[0]),
				command(mergeCommands[1]),
				write(DEVELOPMENT_FILES.cart, DEVELOPMENT_REFERENCE_CONTENT.mergedCart),
				command(mergeCommands[2]),
				command(mergeCommands[3]),
				command(mergeCommands[4]),
			]
		case "devMigrationUpgrade":
			return [
				read(DEVELOPMENT_FILES.data),
				read(DEVELOPMENT_FILES.migration),
				write(DEVELOPMENT_FILES.migration, DEVELOPMENT_REFERENCE_CONTENT.migrationFinal),
				command(migrationCommands[0]),
				command(migrationCommands[1]),
			]
		case "devMigrationRerun":
			return [
				read(DEVELOPMENT_FILES.data),
				read(DEVELOPMENT_FILES.migration),
				command(migrationCommands[0]),
				command(migrationCommands[1]),
			]
	}
}
