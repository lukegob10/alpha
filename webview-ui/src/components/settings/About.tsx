import { HTMLAttributes } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { Trans } from "react-i18next"
import { Download, Upload, TriangleAlert } from "lucide-react"
import { VSCodeCheckbox, VSCodeLink } from "@vscode/webview-ui-toolkit/react"

import type { TelemetrySetting } from "@alpha-code/types"

import { Package } from "@alpha/package"

import { vscode } from "@/utils/vscode"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui"

import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

type AboutProps = HTMLAttributes<HTMLDivElement> & {
	telemetrySetting: TelemetrySetting
	setTelemetrySetting: (setting: TelemetrySetting) => void
	debug?: boolean
	setDebug?: (debug: boolean) => void
}

export const About = ({ telemetrySetting, setTelemetrySetting, debug, setDebug, className, ...props }: AboutProps) => {
	const { t } = useAppTranslation()

	return (
		<div className={cn("flex flex-col gap-2", className)} {...props}>
			<SectionHeader>{t("settings:sections.about")}</SectionHeader>

			<Section>
				<p>
					{Package.sha
						? `Version: ${Package.version} (${Package.sha.slice(0, 8)})`
						: `Version: ${Package.version}`}
				</p>
				<SearchableSetting
					settingId="about-telemetry"
					section="about"
					label={t("settings:footer.telemetry.label")}>
					<VSCodeCheckbox
						checked={telemetrySetting !== "disabled"}
						onChange={(e: any) => {
							const checked = e.target.checked === true
							setTelemetrySetting(checked ? "enabled" : "disabled")
						}}>
						{t("settings:footer.telemetry.label")}
					</VSCodeCheckbox>
					<p className="text-vscode-descriptionForeground text-sm mt-0">
						<Trans
							i18nKey="settings:footer.telemetry.description"
							components={{
								privacyLink: (
									<VSCodeLink href="https://github.com/AlphaInc/Alpha/blob/main/PRIVACY.md" />
								),
							}}
						/>
					</p>
				</SearchableSetting>
			</Section>

			{setDebug && (
				<Section className="space-y-0">
					<SearchableSetting
						settingId="about-debug-mode"
						section="about"
						label={t("settings:about.debugMode.label")}>
						<VSCodeCheckbox
							checked={debug ?? false}
							onChange={(e: any) => {
								const checked = e.target.checked === true
								setDebug(checked)
							}}>
							{t("settings:about.debugMode.label")}
						</VSCodeCheckbox>
						<p className="text-vscode-descriptionForeground text-sm mt-0">
							{t("settings:about.debugMode.description")}
						</p>
					</SearchableSetting>
				</Section>
			)}

			<Section className="space-y-0">
				<SearchableSetting
					settingId="about-manage-settings"
					section="about"
					label={t("settings:about.manageSettings")}>
					<h3>{t("settings:about.manageSettings")}</h3>
					<div className="flex flex-wrap items-center gap-2">
						<Button onClick={() => vscode.postMessage({ type: "exportSettings" })} className="w-28">
							<Upload className="p-0.5" />
							{t("settings:footer.settings.export")}
						</Button>
						<Button onClick={() => vscode.postMessage({ type: "importSettings" })} className="w-28">
							<Download className="p-0.5" />
							{t("settings:footer.settings.import")}
						</Button>
						<Button
							variant="destructive"
							onClick={() => vscode.postMessage({ type: "resetState" })}
							className="w-28">
							<TriangleAlert className="p-0.5" />
							{t("settings:footer.settings.reset")}
						</Button>
					</div>
				</SearchableSetting>
			</Section>
		</div>
	)
}
