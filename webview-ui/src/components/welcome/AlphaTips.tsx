import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useTranslation } from "react-i18next"
import { Trans } from "react-i18next"

import { buildDocLink } from "@src/utils/docLinks"
import { ReplaceAll, Users } from "lucide-react"

const tips = [
	{
		icon: <Users className="size-4 shrink-0 mt-0.5" />,
		href: buildDocLink("basic-usage/using-modes", "tips"),
		titleKey: "alphaTips.customizableModes.title",
		descriptionKey: "alphaTips.customizableModes.description",
	},
	{
		icon: <ReplaceAll className="size-4 shrink-0 mt-0.5" />,
		href: buildDocLink("getting-started/connecting-api-provider", "tips"),
		titleKey: "alphaTips.modelAgnostic.title",
		descriptionKey: "alphaTips.modelAgnostic.description",
	},
]

const AlphaTips = () => {
	const { t } = useTranslation("chat")

	return (
		<div className="flex max-w-[560px] flex-col gap-3 rounded-2xl border border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--surface-sunken)_82%,transparent)] p-4 text-vscode-descriptionForeground">
			<p className="my-0 pr-2">
				<Trans i18nKey="chat:about" />
			</p>
			<div className="gap-4">
				{tips.map((tip) => (
					<div key={tip.titleKey} className="mt-2 flex items-start gap-2.5 leading-relaxed">
						<span className="mt-0.5 text-[var(--alpha-accent)]">{tip.icon}</span>
						<span>
							<VSCodeLink className="text-vscode-textLink-foreground no-underline" href={tip.href}>
								{t(tip.titleKey)}
							</VSCodeLink>
							: {t(tip.descriptionKey)}
						</span>
					</div>
				))}
			</div>
			<p className="my-0">
				<Trans
					i18nKey="chat:docs"
					components={{
						DocsLink: (
							<VSCodeLink
								className="text-vscode-textLink-foreground no-underline"
								href={buildDocLink("", "welcome")}
							/>
						),
					}}
				/>
			</p>
		</div>
	)
}

export default AlphaTips
