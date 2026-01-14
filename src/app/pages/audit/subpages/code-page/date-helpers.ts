import { MomentDay } from "./types";

export interface Week {
  days: MomentDay[];
  isGap: boolean;
}

export interface MonthLabel {
  label: string;
  index: number;
}

/**
 * Group daily data into weeks (7 days per week)
 */
export function groupIntoWeeks(data: MomentDay[]): Week[] {
  if (data.length === 0) {
    return [];
  }

  const weeks: Week[] = [];
  let currentWeek: MomentDay[] = [];

  // Find the day of week for the first date
  const firstDate = new Date(data[0].date);
  const firstDayOfWeek = firstDate.getDay(); // 0 = Sunday, 1 = Monday, etc.

  // Add empty days at the start to align with Monday
  // GitHub-style heatmaps start on Monday (day 1)
  const daysToAdd = firstDayOfWeek === 0 ? 6 : firstDayOfWeek - 1;
  for (let i = 0; i < daysToAdd; i++) {
    const emptyDate = new Date(firstDate);
    emptyDate.setDate(emptyDate.getDate() - (daysToAdd - i));
    currentWeek.push({
      date: emptyDate.toISOString().split("T")[0],
      count: 0,
    });
  }

  for (const day of data) {
    currentWeek.push(day);

    if (currentWeek.length === 7) {
      weeks.push({ days: [...currentWeek], isGap: false });
      currentWeek = [];
    }
  }

  // Add remaining days to complete the last week
  if (currentWeek.length > 0) {
    // Fill remaining days with empty entries
    while (currentWeek.length < 7) {
      const lastDate = new Date(
        currentWeek[currentWeek.length - 1]?.date || data[data.length - 1].date
      );
      const nextDate = new Date(lastDate);
      nextDate.setDate(nextDate.getDate() + 1);
      currentWeek.push({
        date: nextDate.toISOString().split("T")[0],
        count: 0,
      });
    }
    weeks.push({ days: currentWeek, isGap: false });
  }

  return weeks;
}

/**
 * Compress weeks by removing weeks with all zero counts (gaps)
 */
export function compressWeeks(weeks: Week[], threshold: number): Week[] {
  if (weeks.length <= threshold) {
    return weeks;
  }

  const compressed: Week[] = [];
  let gapCount = 0;

  for (const week of weeks) {
    const hasActivity = week.days.some((day) => day.count > 0);

    if (!hasActivity) {
      gapCount++;
      // Only add gap if we haven't exceeded threshold
      if (gapCount <= threshold) {
        compressed.push({ ...week, isGap: true });
      }
    } else {
      // Reset gap count when we find activity
      gapCount = 0;
      compressed.push(week);
    }
  }

  return compressed;
}

/**
 * Get month labels for the heatmap header
 */
export function getMonthLabels(weeks: Week[]): MonthLabel[] {
  if (weeks.length === 0) {
    return [];
  }

  const labels: MonthLabel[] = [];
  let lastMonth = -1;

  for (let weekIdx = 0; weekIdx < weeks.length; weekIdx++) {
    const week = weeks[weekIdx];
    if (week.days.length === 0) continue;

    // Get the first day of the week (Monday)
    const firstDay = week.days[0];
    if (!firstDay) continue;

    const date = new Date(firstDay.date);
    const month = date.getMonth();

    // Only add label if it's a new month or the first week
    if (month !== lastMonth || weekIdx === 0) {
      const monthName = date.toLocaleDateString("en-US", { month: "short" });
      labels.push({
        label: monthName,
        index: weekIdx,
      });
      lastMonth = month;
    }
  }

  return labels;
}
