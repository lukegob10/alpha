import { cn } from "@/lib/utils"
import { useAppTranslation } from "@/i18n/TranslationContext"

type AlphaHeroProps = {
	variant?: "compact" | "welcome" | "watermark"
	className?: string
}

type AlphaWolfIconProps = {
	className?: string
	variant?: "primary" | "watermark"
}

const getImagesBaseUri = () => {
	if (typeof window === "undefined") {
		return ""
	}

	return ((window as Window & { IMAGES_BASE_URI?: string }).IMAGES_BASE_URI || "").replace(/\/$/, "")
}

const AlphaWolfIcon = ({ className, variant = "primary" }: AlphaWolfIconProps) => {
	const imagesBaseUri = getImagesBaseUri()
	const filename = variant === "watermark" ? "alpha-wolf-watermark.svg" : "alpha-wolf-logo.svg"
	const logoSrc = `${imagesBaseUri}/${filename}`

	return (
		<img
			src={logoSrc}
			alt=""
			aria-hidden="true"
			className={cn("block object-contain object-left", className)}
			data-testid="alpha-wolf-icon"
			draggable={false}
		/>
	)
}

const AlphaHero = ({ variant = "compact", className }: AlphaHeroProps) => {
	const { t } = useAppTranslation()

	if (variant === "watermark") {
		return (
			<div
				aria-hidden="true"
				className={cn("flex w-full items-center justify-center forced-color-adjust-none", className)}>
				<AlphaWolfIcon
					variant="watermark"
					className="brand-mark brand-mark-watermark h-24 w-24 min-[400px]:h-32 min-[400px]:w-32"
				/>
			</div>
		)
	}

	const isWelcome = variant === "welcome"

	return (
		<div className={cn("flex min-w-0 shrink-0 items-center", isWelcome ? "gap-3" : "gap-1.5", className)}>
			<AlphaWolfIcon
				className={cn(
					"brand-mark shrink-0",
					isWelcome ? "h-14 w-16 min-[400px]:h-20 min-[400px]:w-24" : "h-5 w-6",
				)}
			/>
			<span
				className={cn(
					"brand-title origin-left scale-x-105 font-semibold leading-none",
					isWelcome ? "text-[32px] min-[400px]:text-[42px]" : "text-[13px]",
				)}>
				{t("common:brand.name")}
			</span>
		</div>
	)
}

export default AlphaHero
