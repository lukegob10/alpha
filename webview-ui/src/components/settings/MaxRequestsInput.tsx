import { useId } from "react"
import { useTranslation } from "react-i18next"

import { FormattedTextField, unlimitedIntegerFormatter } from "../common/FormattedTextField"

interface MaxRequestsInputProps {
	allowedMaxRequests?: number
	onValueChange: (value: number | undefined) => void
	descriptionId?: string
}

export function MaxRequestsInput({ allowedMaxRequests, onValueChange, descriptionId }: MaxRequestsInputProps) {
	const { t } = useTranslation()
	const inputId = useId()
	const label = t("settings:autoApprove.apiRequestLimit.title")

	return (
		<>
			<label htmlFor={inputId} className="flex min-w-0 items-center gap-2 text-sm font-medium">
				<span className="codicon codicon-pulse shrink-0" aria-hidden="true" />
				<span className="min-w-0 break-words">{label}:</span>
			</label>
			<FormattedTextField
				id={inputId}
				aria-label={label}
				aria-describedby={descriptionId}
				value={allowedMaxRequests}
				onValueChange={onValueChange}
				formatter={unlimitedIntegerFormatter}
				placeholder={t("settings:autoApprove.apiRequestLimit.unlimited")}
				style={{ minWidth: 0, width: "100%", maxWidth: "200px" }}
				data-testid="max-requests-input">
				<span className="sr-only">{label}</span>
			</FormattedTextField>
		</>
	)
}
