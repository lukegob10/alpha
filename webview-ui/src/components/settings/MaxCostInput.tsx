import { useId } from "react"
import { useTranslation } from "react-i18next"

import { FormattedTextField, unlimitedDecimalFormatter } from "../common/FormattedTextField"

interface MaxCostInputProps {
	allowedMaxCost?: number
	onValueChange: (value: number | undefined) => void
	descriptionId?: string
}

export function MaxCostInput({ allowedMaxCost, onValueChange, descriptionId }: MaxCostInputProps) {
	const { t } = useTranslation()
	const inputId = useId()
	const label = t("settings:autoApprove.apiCostLimit.title")

	return (
		<>
			<label htmlFor={inputId} className="flex min-w-0 items-center gap-2 text-sm font-medium">
				<span className="codicon codicon-credit-card shrink-0" aria-hidden="true" />
				<span className="min-w-0 break-words">{label}:</span>
			</label>
			<FormattedTextField
				id={inputId}
				aria-label={label}
				aria-describedby={descriptionId}
				value={allowedMaxCost}
				onValueChange={onValueChange}
				formatter={unlimitedDecimalFormatter}
				placeholder={t("settings:autoApprove.apiCostLimit.unlimited")}
				style={{ minWidth: 0, width: "100%", maxWidth: "200px" }}
				data-testid="max-cost-input"
				leftNodes={[<span key="dollar">$</span>]}>
				<span className="sr-only">{label}</span>
			</FormattedTextField>
		</>
	)
}
