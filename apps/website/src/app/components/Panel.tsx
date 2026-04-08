import { ReactNode } from "react";

function cn(...classes: (string | undefined | false)[]) {
  return classes.filter(Boolean).join(" ");
}

interface PanelProps {
  children: ReactNode;
  className?: string;
  title?: string;
  glow?: boolean;
}

export function Panel({ children, className, title, glow = false }: PanelProps) {
  return (
    <div
      className={cn(
        "relative bg-[#161b18] border border-[#2b483e] rounded-sm overflow-clip",
        glow && "shadow-[0_0_15px_rgba(82,139,118,0.15)] border-[#3f6f5e]",
        className,
      )}
    >
      {title && (
        <div className="bg-[#12211c] border-b border-[#2b483e] px-4 py-2 flex items-center justify-between">
          <span className="font-mono text-xs text-[#9bc5b3] uppercase tracking-wider">{title}</span>
          <div className="flex gap-1.5">
            <div className="w-2 h-2 rounded-full bg-[#2b483e]"></div>
            <div className="w-2 h-2 rounded-full bg-[#2b483e]"></div>
            <div className="w-2 h-2 rounded-full bg-[#528b76] animate-pulse"></div>
          </div>
        </div>
      )}
      <div className="p-6">{children}</div>
    </div>
  );
}
