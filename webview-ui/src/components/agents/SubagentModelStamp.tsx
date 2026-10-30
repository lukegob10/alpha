import type { SubagentModelRouteState } from "@alpha-code/types"
import { useTranslation } from "react-i18next"

/** Display only the child's captured route; old records must not borrow current parent settings. */
export function SubagentModelStamp({
	modelRoute,
	includeProfile = false,
}: {
	modelRoute?: SubagentModelRouteState
	includeProfile?: boolean
}) {
	const { t } = useTranslation("chat")
	if (!modelRoute) return null
	const capturedConfiguration = modelRoute.reasoningConfiguration
	const effective = modelRoute.effectiveReasoning
	const legacyEffort =
		capturedConfiguration?.enableReasoningEffort === true && capturedConfiguration.reasoningEffort !== "disable"
			? capturedConfiguration.reasoningEffort
			: undefined
	const reasoning = effective
		? effective.kind === "effort"
			? t("subagentRow.reasoning.effort", { effort: effective.effort })
			: effective.kind === "custom"
				? t("subagentRow.reasoning.custom", { value: effective.value })
				: t(`subagentRow.reasoning.${effective.kind}`)
		: legacyEffort
			? t("subagentRow.reasoning.effort", { effort: legacyEffort })
			: t(
					capturedConfiguration?.enableReasoningEffort === false
						? "subagentRow.reasoning.off"
						: "subagentRow.reasoning.unknown",
				)
	const model = includeProfile
		? [modelRoute.profileName, modelRoute.provider, modelRoute.modelId].filter(Boolean).join(" · ")
		: (modelRoute.modelId ?? modelRoute.profileName)
	return <span>{[model, reasoning].filter(Boolean).join(" · ")}</span>
}
