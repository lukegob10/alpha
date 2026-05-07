import { cn } from "@/lib/utils"

type RooHeroProps = {
	variant?: "compact" | "welcome"
	className?: string
}

type AlphaWolfIconProps = {
	className?: string
}

const getImagesBaseUri = () => {
	if (typeof window === "undefined") {
		return ""
	}

	return ((window as Window & { IMAGES_BASE_URI?: string }).IMAGES_BASE_URI || "").replace(/\/$/, "")
}

const AlphaWolfIcon = ({ className }: AlphaWolfIconProps) => {
	const imagesBaseUri = getImagesBaseUri()
	const logoSrc = imagesBaseUri ? `${imagesBaseUri}/alpha-wolf-logo.svg` : "/alpha-wolf-logo.svg"

	return (
		<img
			src={logoSrc}
			alt="Alpha wolf logo"
			className={cn("block object-contain object-left", className)}
			data-testid="alpha-wolf-icon"
			draggable={false}
		/>
	)
}

const RooHero = ({ variant = "compact", className }: RooHeroProps) => {
	if (variant === "welcome") {
		return (
			<div className={cn("relative forced-color-adjust-none flex w-full items-start overflow-visible", className)}>
				<AlphaWolfIcon
					className="h-28 w-36 origin-left scale-125 drop-shadow-[0_10px_28px_rgba(255,255,255,0.16)]"
				/>
			</div>
		)
	}

	return (
		<div
			className={cn(
				"mb-4 relative forced-color-adjust-none flex flex-col items-center w-30 pt-4",
				className,
			)}>
			<AlphaWolfIcon className="z-5 mr-auto h-8 w-12 origin-left scale-125" />
		</div>
	)
}

export default RooHero
