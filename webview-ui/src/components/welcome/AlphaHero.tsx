import { cn } from "@/lib/utils"

type AlphaHeroProps = {
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

const AlphaHero = ({ variant = "compact", className }: AlphaHeroProps) => {
	if (variant === "welcome") {
		return (
			<div
				className={cn("relative forced-color-adjust-none flex w-full items-start overflow-visible", className)}>
				<AlphaWolfIcon className="brand-mark h-28 w-36 origin-left scale-125" />
			</div>
		)
	}

	return (
		<div className={cn("relative mb-1 flex w-30 flex-col items-center pt-2 forced-color-adjust-none", className)}>
			<AlphaWolfIcon className="brand-mark z-5 mr-auto h-8 w-12 origin-left scale-125" />
		</div>
	)
}

export default AlphaHero
