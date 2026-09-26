import Image from "next/image";
import Link from "next/link";

interface GitGuardLogoProps {
  size?: "sm" | "md" | "lg";
  showWordmark?: boolean;
  className?: string;
  linkHref?: string;
}

export function GitGuardLogo({
  size = "md",
  showWordmark = true,
  className = "",
  linkHref = "/",
}: GitGuardLogoProps) {
  const sizeStyles = ({
  sm: { badge: "w-8 h-8 rounded-lg p-1", img: 22, text: "text-sm", badgeText: "text-[10px]" },
  md: { badge: "w-9 h-9 rounded-xl p-1.5", img: 26, text: "text-base", badgeText: "text-[11px]" },
  lg: { badge: "w-11 h-11 rounded-2xl p-2", img: 32, text: "text-lg", badgeText: "text-xs" }
}[size]) ?? { badge: "w-9 h-9 rounded-xl p-1.5", img: 26, text: "text-base", badgeText: "text-[11px]" };

  const content = (
    <div className={`flex items-center gap-3 group select-none ${className}`}>
      {/* Icon Badge */}
      <div
        className={`relative ${sizeStyles.badge} bg-gradient-to-br from-slate-900 via-slate-900 to-slate-950 border border-slate-800/90 flex items-center justify-center text-white shadow-md shadow-slate-950/20 shrink-0 transition-transform duration-200 group-hover:scale-105`}
      >
        <Image
          src="/images/gitguard-logo.png"
          alt="GitGuard Logo"
          width={sizeStyles.img}
          height={sizeStyles.img}
          className="object-contain drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)] brightness-110"
          priority
        />
      </div>

      {/* Wordmark & Version */}
      {showWordmark && (
        <div className="flex items-center gap-2 overflow-hidden">
          <span
            className={`font-bold tracking-tight text-slate-950 ${sizeStyles.text} whitespace-nowrap`}
          >
            GitGuard
          </span>
          <span
            className={`font-mono px-1.5 py-0.5 rounded bg-slate-100/90 text-slate-600 border border-slate-200 font-semibold ${sizeStyles.badgeText} shrink-0`}
          >
            v1.2
          </span>
        </div>
      )}
    </div>
  );

  if (linkHref) {
    return (
      <Link href={linkHref} className="focus:outline-none inline-block">
        {content}
      </Link>
    );
  }

  return content;
}
