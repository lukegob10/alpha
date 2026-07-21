import React from "react"
import { useTranslation } from "react-i18next"
import { Package } from "@alpha/package"

interface VersionIndicatorProps {
	onClick: () => void
	className?: string
}

const VersionIndicator: React.FC<VersionIndicatorProps> = ({ onClick, className = "" }) => {
	const { t } = useTranslation()

	return (
		<button
			onClick={onClick}
			className={`accent-chip cursor-pointer rounded-full px-2.5 py-1 text-xs transition-colors hover:bg-[var(--alpha-accent-soft)] ${className}`}
			aria-label={t("chat:versionIndicator.ariaLabel", { version: Package.version })}>
			v{Package.version}
		</button>
	)
}

export default VersionIndicator
