"use client";

import { useEffect, useState } from "react";

const START_DATE_UTC = Date.UTC(2026, 2, 16);
const DAY_IN_MS = 24 * 60 * 60 * 1000;

function getDayCount() {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  return Math.max(1, Math.floor((todayUtc - START_DATE_UTC) / DAY_IN_MS) + 1);
}

export function DayCount() {
  const [day, setDay] = useState(getDayCount);

  useEffect(() => {
    const updateDay = () => setDay(getDayCount());
    updateDay();

    const interval = window.setInterval(updateDay, 60 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <span suppressHydrationWarning className="font-mono text-[12px] text-violet-600">
      Day {day}
    </span>
  );
}
