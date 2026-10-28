import { executedExperimentCaptureSchema, type ExecutedExperimentCapture } from "@alpha-code/types"
import { canonicalJson, sha256 } from "./canonical"

export { executedExperimentCaptureSchema }
export type { ExecutedExperimentCapture } from "@alpha-code/types"

/** Generation options come from the actual VS Code sendRequest boundary, never requested experiment settings. */
export function executedModelSettingsDigest(
	model: string,
	reasoningEffort: string,
	generationOptionsDigest: string,
): string {
	if (!/^sha256:[a-f0-9]{64}$/.test(generationOptionsDigest)) throw new Error("Missing observed generation options")
	return sha256(canonicalJson({ model, reasoningEffort, generationOptionsDigest }))
}

/** A content seal detects changed receipts. It does not authenticate the caller or the host. */
export function sealExecutedExperimentCapture(
	body: Omit<ExecutedExperimentCapture, "digest">,
): ExecutedExperimentCapture {
	const parsed = executedExperimentCaptureSchema.parse({ ...body, digest: sha256(canonicalJson(body)) })
	const { digest: _digest, ...normalized } = parsed
	return { ...normalized, digest: sha256(canonicalJson(normalized)) }
}

export function parseExecutedExperimentCapture(value: unknown): ExecutedExperimentCapture {
	const receipt = executedExperimentCaptureSchema.parse(value)
	const { digest, ...body } = receipt
	if (digest !== sha256(canonicalJson(body))) throw new Error("Executed experiment capture seal differs")
	return receipt
}
