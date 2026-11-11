import { HTMLAttributes } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { Slider } from "@/components/ui"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section, useSectionGroup } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { SettingsHelp } from "./SettingsHelp"
import type { SettingsSectionId } from "./settingsNavigation"
import {
	DEFAULT_CHECKPOINT_TIMEOUT_SECONDS,
	MAX_CHECKPOINT_TIMEOUT_SECONDS,
	MIN_CHECKPOINT_TIMEOUT_SECONDS,
} from "@alpha-code/types"

type CheckpointSettingsProps = HTMLAttributes<HTMLDivElement> & {
	enableCheckpoints?: boolean
	checkpointTimeout?: number
	embedded?: boolean
	searchSection?: SettingsSectionId
	setCachedStateField: SetCachedStateField<"enableCheckpoints" | "checkpointTimeout">
}

export const CheckpointSettings = ({
	enableCheckpoints = true,
	checkpointTimeout,
	embedded = false,
	searchSection = "checkpoints",
	setCachedStateField,
	...props
}: CheckpointSettingsProps) => {
	const { t } = useAppTranslation()
	const grouped = useSectionGroup()
	return (
		<div {...props}>
			{!embedded && <SectionHeader>{t("settings:sections.checkpoints")}</SectionHeader>}

			<Section>
				{embedded && !grouped && (
					<h4 className="m-0 text-base font-semibold">{t("settings:checkpoints.recoveryTitle")}</h4>
				)}
				<SearchableSetting
					settingId="checkpoints-enable"
					section={searchSection}
					label={t("settings:checkpoints.enable.label")}>
					<div className="flex items-center gap-1">
						<VSCodeCheckbox
							checked={enableCheckpoints}
							onChange={(e: any) => {
								setCachedStateField("enableCheckpoints", e.target.checked)
							}}>
							<span className="font-medium">{t("settings:checkpoints.enable.label")}</span>
						</VSCodeCheckbox>
						<SettingsHelp label={t("settings:checkpoints.enable.label")}>
							{t("settings:checkpoints.enable.description")}
						</SettingsHelp>
					</div>
				</SearchableSetting>

				{enableCheckpoints && (
					<SearchableSetting
						settingId="checkpoints-timeout"
						section={searchSection}
						label={t("settings:checkpoints.timeout.label")}>
						<div className="mb-2 flex items-center gap-1">
							<span className="text-sm font-medium">{t("settings:checkpoints.timeout.label")}</span>
							<SettingsHelp label={t("settings:checkpoints.timeout.label")}>
								{t("settings:checkpoints.timeout.description")}
							</SettingsHelp>
						</div>
						<div className="flex items-center gap-2">
							<Slider
								min={MIN_CHECKPOINT_TIMEOUT_SECONDS}
								max={MAX_CHECKPOINT_TIMEOUT_SECONDS}
								step={1}
								value={[checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS]}
								aria-label={t("settings:checkpoints.timeout.label")}
								onValueChange={([value]) => {
									setCachedStateField("checkpointTimeout", value)
								}}
								className="flex-1"
								data-testid="checkpoint-timeout-slider"
							/>
							<span className="w-12 text-center">
								{checkpointTimeout ?? DEFAULT_CHECKPOINT_TIMEOUT_SECONDS}
							</span>
						</div>
					</SearchableSetting>
				)}
			</Section>
		</div>
	)
}
