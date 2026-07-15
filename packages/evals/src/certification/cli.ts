import path from "node:path"

import { EVALS_REPO_PATH } from "../exercises/index"
import { certifySuite, loadCertificationSuite } from "./runner"

const suitePath = path.resolve(process.argv[2] ?? path.join(EVALS_REPO_PATH, "certification", "suite.json"))
const suite = await loadCertificationSuite(suitePath)
const serial = await certifySuite(suite, { repetitions: 20, concurrency: 1 })
const concurrent = await certifySuite(suite, { repetitions: 5, concurrency: suite.concurrency })
console.log(
	JSON.stringify({
		certified: true,
		suite: suite.id,
		scenarios: suite.scenarios.length,
		serialRuns: serial.runs.length,
		concurrentRuns: concurrent.runs.length,
		canonicalResult: serial.canonicalResult,
	}),
)
