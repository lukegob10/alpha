import { canonicalJson } from "../evidence/index"
import type { PairKey, PairedTrial, TrialObservation } from "./types"

const keyFields: (keyof PairKey)[] = [
	"taskId",
	"taskVersion",
	"seed",
	"repetition",
	"resourceProfileDigest",
	"permissionDigest",
	"networkMode",
	"retryPolicyDigest",
	"timeWindow",
]

export function pairTrials(control: TrialObservation[], candidate: TrialObservation[]): PairedTrial[] {
	const candidateByKey = new Map(candidate.map((trial) => [pairIdentity(trial), trial]))
	if (candidateByKey.size !== candidate.length) throw new Error("Candidate trials contain duplicate pair identities")
	const pairs = control.map((controlTrial) => {
		const identity = pairIdentity(controlTrial)
		const candidateTrial = candidateByKey.get(identity)
		if (!candidateTrial) throw new Error(`Missing candidate pair for ${identity}`)
		candidateByKey.delete(identity)
		assertPairCompatible(controlTrial, candidateTrial)
		return { key: pickKey(controlTrial), control: controlTrial, candidate: candidateTrial }
	})
	if (candidateByKey.size > 0) throw new Error(`Unpaired candidate trials: ${[...candidateByKey.keys()].join(", ")}`)
	return pairs
}

export function assertPairCompatible(control: TrialObservation, candidate: TrialObservation): void {
	for (const field of keyFields) {
		if (control[field] !== candidate[field]) throw new Error(`Pair mismatch in ${field}`)
	}
}

function pairIdentity(value: PairKey): string {
	return canonicalJson(pickKey(value))
}

function pickKey(value: PairKey): PairKey {
	return Object.fromEntries(keyFields.map((field) => [field, value[field]])) as PairKey
}
