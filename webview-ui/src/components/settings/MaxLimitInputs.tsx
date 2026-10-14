import React, { useId } from "react"
import { useTranslation } from "react-i18next"
import { MaxRequestsInput } from "./MaxRequestsInput"
import { MaxCostInput } from "./MaxCostInput"

export interface MaxLimitInputsProps {
	allowedMaxRequests?: number
	allowedMaxCost?: number
	onMaxRequestsChange: (value: number | undefined) => void
	onMaxCostChange: (value: number | undefined) => void
}

export const MaxLimitInputs: React.FC<MaxLimitInputsProps> = ({
	allowedMaxRequests,
	allowedMaxCost,
	onMaxRequestsChange,
	onMaxCostChange,
}) => {
	const { t } = useTranslation()
	const descriptionId = useId()

	return (
		<div className="space-y-2">
			<div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-2 gap-y-2 items-center">
				<MaxRequestsInput
					allowedMaxRequests={allowedMaxRequests}
					onValueChange={onMaxRequestsChange}
					descriptionId={descriptionId}
				/>
				<MaxCostInput
					allowedMaxCost={allowedMaxCost}
					onValueChange={onMaxCostChange}
					descriptionId={descriptionId}
				/>
			</div>
			<div id={descriptionId} className="text-xs text-vscode-descriptionForeground">
				{t("settings:autoApprove.maxLimits.description")}
			</div>
		</div>
	)
}
