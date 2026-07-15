import path from "node:path"

import { EVALS_REPO_PATH } from "../exercises/index"
import { certifySuite, loadCertificationSuite } from "./runner"

let activePreflight: Promise<void> | undefined

export function certifyHarness(): Promise<void> {
	activePreflight ??= runPreflight().catch((error) => {
		activePreflight = undefined
		throw error
	})
	return activePreflight
}

async function runPreflight(): Promise<void> {
	const suite = await loadCertificationSuite(path.join(EVALS_REPO_PATH, "certification", "suite.json"))
	await certifySuite(suite, { repetitions: 20, concurrency: 1 })
	await certifySuite(suite, { repetitions: 5, concurrency: suite.concurrency })
}
