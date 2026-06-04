import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"

import { useAppTranslation } from "@/i18n/TranslationContext"

import { SearchableSetting } from "./SearchableSetting"
import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"

interface GitHubSettingsProps {
	githubToken?: string
	setGithubToken: (token: string) => void
}

export const GitHubSettings = ({ githubToken, setGithubToken }: GitHubSettingsProps) => {
	const { t } = useAppTranslation()

	return (
		<div>
			<SectionHeader>{t("settings:sections.github")}</SectionHeader>

			<Section>
				<SearchableSetting settingId="github-token" section="github" label={t("settings:github.tokenLabel")}>
					<label className="block font-medium mb-1">{t("settings:github.tokenLabel")}</label>
					<VSCodeTextField
						value={githubToken || ""}
						onInput={(e: any) => setGithubToken(e.target.value)}
						placeholder={t("settings:github.tokenPlaceholder")}
						className="w-full"
						type="password"
					/>
					<p className="text-vscode-descriptionForeground text-xs mt-1">
						{t("settings:github.tokenDescription")}
					</p>
				</SearchableSetting>
			</Section>
		</div>
	)
}
