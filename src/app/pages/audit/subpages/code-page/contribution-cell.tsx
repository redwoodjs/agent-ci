import { MomentDay } from "./types";

interface Props {
  day: MomentDay;
  isGap: boolean;
  isSelected?: boolean;
  onClick?: () => void;
}

/**
 * Get the background color class based on count
 */
function getColorClass(count: number): string {
  if (count === 0) return "bg-gray-100";
  if (count <= 2) return "bg-green-200";
  if (count <= 5) return "bg-green-400";
  if (count <= 10) return "bg-green-600";
  return "bg-green-800";
}

export default function ContributionCell({
  day,
  isGap,
  isSelected = false,
  onClick,
}: Props) {
  const colorClass = isGap ? "bg-gray-50" : getColorClass(day.count);

  return (
    <div
      className={`w-3 h-3 rounded-sm ${colorClass} transition-all cursor-pointer ${
        isSelected
          ? "ring-2 ring-blue-500 ring-offset-1 scale-110 z-10 relative"
          : "hover:ring-2 hover:ring-green-400 hover:ring-offset-1"
      }`}
      title={`${day.date}: ${day.count} moment${day.count !== 1 ? "s" : ""}`}
      onClick={onClick}
    />
  );
}
