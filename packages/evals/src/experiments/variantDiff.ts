import type { ExperimentTemplate, ExperimentVariant } from "./types"

export type VariantDifference = { field: keyof ExperimentVariant; control: unknown; candidate: unknown }

const modelFields = new Set<keyof ExperimentVariant>(["model", "modelSettingsDigest"])

export function diffVariants(control: ExperimentVariant, candidate: ExperimentVariant): VariantDifference[] {
	return (Object.keys(control) as (keyof ExperimentVariant)[])
		.filter((field) => JSON.stringify(control[field]) !== JSON.stringify(candidate[field]))
		.map((field) => ({ field, control: control[field], candidate: candidate[field] }))
}

export function validateTemplateDiff(template: ExperimentTemplate, differences: VariantDifference[]): void {
	const forbidden = differences.filter(({ field }) =>
		template === "model_only" ? !modelFields.has(field) : modelFields.has(field),
	)
	if (forbidden.length > 0)
		throw new Error(`${template} experiment has confounders: ${forbidden.map(({ field }) => field).join(", ")}`)
	if (differences.length === 0) throw new Error("Experiment variants are identical")
}

export function validateDeclaredVariantDiff(
	differences: VariantDifference[],
	allowedFields: Array<keyof ExperimentVariant>,
): void {
	const allowed = new Set(allowedFields)
	const undeclared = differences.filter(({ field }) => !allowed.has(field))
	if (undeclared.length)
		throw new Error(`experiment has undeclared confounders: ${undeclared.map(({ field }) => field).join(", ")}`)
	for (const field of allowed)
		if (!differences.some((difference) => difference.field === field))
			throw new Error(`declared variant difference is unchanged: ${field}`)
}
