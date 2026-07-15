import * as fs from "fs"
import * as path from "path"
import { fileURLToPath } from "url"

import { loadCampaignConfig } from "./schema"
import { CampaignRunner } from "./runner"

function valueAfter(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag)
	return index >= 0 ? args[index + 1] : undefined
}

function usage(): never {
	console.error("Usage: campaign <init|validate|status|run-validation> --config <path> [--dry-run] [--resume]")
	process.exit(2)
}

export function findRepositoryRoot(start = process.env.INIT_CWD ?? process.cwd()): string {
	let current = path.resolve(start)
	while (true) {
		if (
			fs.existsSync(path.join(current, "docs", "core-harness-comparison.md")) &&
			fs.existsSync(path.join(current, "package.json"))
		)
			return current
		const parent = path.dirname(current)
		if (parent === current) throw new Error(`Unable to find repository root from ${start}`)
		current = parent
	}
}

export async function main(args = process.argv.slice(2)): Promise<void> {
	const action = args[0]
	const configArgument = valueAfter(args, "--config")
	if (!action || !configArgument) usage()

	const repositoryRoot = findRepositoryRoot()
	const configPath = path.resolve(repositoryRoot, configArgument)
	const config = await loadCampaignConfig(configPath)
	const runner = new CampaignRunner({ repositoryRoot, config })

	if (action === "init") {
		console.log(JSON.stringify(await runner.initialize(), null, 2))
		return
	}
	if (action === "validate") {
		console.log(JSON.stringify({ valid: true, campaignId: config.id, commands: runner.dryRun() }, null, 2))
		return
	}
	if (action === "status") {
		console.log(JSON.stringify(await runner.readState(), null, 2))
		return
	}
	if (action === "run-validation") {
		if (args.includes("--dry-run")) {
			console.log(JSON.stringify({ dryRun: true, campaignId: config.id, commands: runner.dryRun() }, null, 2))
			return
		}
		const attempt = await runner.runValidation({ resume: args.includes("--resume") })
		console.log(JSON.stringify(attempt, null, 2))
		if (attempt.status !== "passed") process.exitCode = 1
		return
	}
	usage()
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	main().catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
}
