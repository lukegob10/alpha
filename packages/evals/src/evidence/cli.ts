import fs from "node:fs/promises"
import path from "node:path"

import { FilesystemArtifactStore } from "./artifactStore"
import { reconstructEvidenceBundle } from "./reconstruct"
import type { EvidenceBundle } from "./types"

const args = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 2) {
	const key = process.argv[index]
	const value = process.argv[index + 1]
	if (!key?.startsWith("--") || !value) usage()
	args.set(key.slice(2), value)
}

const bundlePath = args.get("bundle")
const attemptId = args.get("attempt")
const storeRoot = args.get("store")
const output = args.get("output")
if ((!bundlePath && !attemptId) || (bundlePath && attemptId) || !storeRoot || !output) usage()

const bundle = bundlePath
	? (JSON.parse(await fs.readFile(path.resolve(bundlePath), "utf8")) as EvidenceBundle)
	: await import("../db/queries/evidence").then(({ getReconstructableEvidenceBundle }) =>
			getReconstructableEvidenceBundle(Number.parseInt(attemptId!, 10)),
		)
await reconstructEvidenceBundle(bundle, new FilesystemArtifactStore(path.resolve(storeRoot)), path.resolve(output))
console.log(JSON.stringify({ reconstructed: true, attemptId: bundle.attemptId, output: path.resolve(output) }))

function usage(): never {
	console.error(
		"Usage: evidence-reconstruct (--bundle <manifest.json> | --attempt <id>) --store <artifact-root> --output <directory>",
	)
	process.exit(2)
}
