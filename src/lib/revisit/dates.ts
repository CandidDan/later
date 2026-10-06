export function formatSavedDate(savedAt: string, now: Date, timeZone: string): { absolute: string; relative: string } {
  const saved = new Date(savedAt);
  if (!Number.isFinite(saved.getTime())) return { absolute: "Saved date unavailable", relative: "" };
  const date = new Intl.DateTimeFormat("en-AU", { timeZone, year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const days = Math.floor((now.getTime() - saved.getTime()) / 86400000);
  const hours = Math.floor((now.getTime() - saved.getTime()) / 3600000);
  return { absolute: date.format(saved), relative: days >= 1 ? `${days} day${days === 1 ? "" : "s"} ago` : hours >= 1 ? `${hours} hour${hours === 1 ? "" : "s"} ago` : "Just saved" };
}
