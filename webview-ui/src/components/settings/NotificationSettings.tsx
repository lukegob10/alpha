import { HTMLAttributes, useRef } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import type { Checkbox } from "@vscode/webview-ui-toolkit"

import { SetCachedStateField } from "./types"
import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"
import { SettingsHelp } from "./SettingsHelp"
import { Slider } from "../ui"

type NotificationSettingsProps = HTMLAttributes<HTMLDivElement> & {
	embedded?: boolean
	unframed?: boolean
	soundEnabled?: boolean
	soundVolume?: number
	setCachedStateField: SetCachedStateField<"soundEnabled" | "soundVolume">
}

export const NotificationSettings = ({
	embedded = false,
	unframed = false,
	soundEnabled = false,
	soundVolume,
	setCachedStateField,
	...props
}: NotificationSettingsProps) => {
	const { t } = useAppTranslation()
	const latestSoundEnabled = useRef(soundEnabled)
	// Toolkit checked updates can emit through the previous render's listener.
	latestSoundEnabled.current = soundEnabled
	const Frame = unframed ? "div" : Section
	return (
		<div {...props}>
			{!embedded && <SectionHeader>{t("settings:sections.notifications")}</SectionHeader>}

			<Frame>
				<SearchableSetting
					settingId="notifications-sound"
					section="notifications"
					label={t("settings:notifications.sound.label")}>
					<div className="flex min-h-11 items-center justify-between gap-2">
						<VSCodeCheckbox
							checked={soundEnabled}
							onChange={(event) => {
								const checked = (event.target as Checkbox).checked
								if (checked !== latestSoundEnabled.current) setCachedStateField("soundEnabled", checked)
							}}
							data-testid="sound-enabled-checkbox">
							<span className="font-medium">{t("settings:notifications.sound.label")}</span>
						</VSCodeCheckbox>
						<SettingsHelp label={t("settings:notifications.sound.label")}>
							{t("settings:notifications.sound.description")}
						</SettingsHelp>
					</div>
				</SearchableSetting>

				{soundEnabled && (
					<div className="flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
						<SearchableSetting
							settingId="notifications-sound-volume"
							section="notifications"
							label={t("settings:notifications.sound.volumeLabel")}>
							<label className="block font-medium mb-1">
								{t("settings:notifications.sound.volumeLabel")}
							</label>
							<div className="flex items-center gap-2">
								<Slider
									aria-label={t("settings:notifications.sound.volumeLabel")}
									min={0}
									max={1}
									step={0.01}
									value={[soundVolume ?? 0.5]}
									onValueChange={([value]) => setCachedStateField("soundVolume", value)}
									data-testid="sound-volume-slider"
								/>
								<span className="w-10">{((soundVolume ?? 0.5) * 100).toFixed(0)}%</span>
							</div>
						</SearchableSetting>
					</div>
				)}
			</Frame>
		</div>
	)
}
