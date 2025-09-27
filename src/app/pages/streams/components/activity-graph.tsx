interface ActivityGraphProps {
  activity: number[];
  eventsCount: number;
}

export function ActivityGraph({ activity, eventsCount }: ActivityGraphProps) {
  return (
    <div className="flex items-center gap-2">
      <div className="grid grid-cols-7 gap-px">
        {activity.map((intensity, index) => (
          <div
            key={index}
            className={`w-2 h-2 rounded-sm ${
              intensity === 0
                ? "bg-muted"
                : intensity <= 0.2
                ? "bg-green-500/20"
                : intensity <= 0.4
                ? "bg-green-500/40"
                : intensity <= 0.6
                ? "bg-green-500/60"
                : intensity <= 0.8
                ? "bg-green-500/80"
                : "bg-green-500"
            }`}
          />
        ))}
      </div>
      <span className="text-xs text-muted-foreground">
        {eventsCount} events this week
      </span>
    </div>
  );
}