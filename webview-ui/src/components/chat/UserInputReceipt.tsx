import type { UserInputResponseData } from "@alpha-code/types"
import { CornerDownRight } from "lucide-react"

import { useAppTranslation } from "@src/i18n/TranslationContext"

export const UserInputReceipt = ({ response }: { response: UserInputResponseData }) => {
	const { t } = useAppTranslation()

	return (
		<section
			className="flex min-w-0 flex-col gap-3 whitespace-normal"
			aria-label={t("chat:requestUserInput.receiptTitle")}
			data-testid="user-input-receipt">
			<header className="flex flex-wrap items-center justify-between gap-2">
				<span className="font-medium">{t("chat:requestUserInput.receiptTitle")}</span>
				<span className="text-xs text-vscode-descriptionForeground">
					{t("chat:requestUserInput.receiptStatus")}
				</span>
			</header>
			<dl className="m-0 flex min-w-0 flex-col">
				{response.questions.map((entry, index) => (
					<div
						key={index}
						className="flex min-w-0 flex-col gap-2 border-b border-vscode-panel-border py-3 first:pt-0 last:border-b-0 last:pb-0">
						<dt className="flex min-w-0 flex-col gap-1">
							{entry.header && (
								<span className="text-xs text-vscode-descriptionForeground">{entry.header}</span>
							)}
							<span className="break-words whitespace-pre-wrap font-medium">{entry.question}</span>
						</dt>
						<dd className="m-0 flex min-w-0 items-start gap-2">
							<CornerDownRight
								className="mt-0.5 size-3.5 shrink-0 text-vscode-descriptionForeground"
								aria-hidden
							/>
							<span className="min-w-0 break-words whitespace-pre-wrap">{entry.answers.join("\n")}</span>
						</dd>
					</div>
				))}
			</dl>
		</section>
	)
}
