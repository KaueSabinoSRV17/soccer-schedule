import { matchLocation } from "./calendar.js";
import type { Match } from "./model.js";

export function displayMatch(match: Match, timezone: string): string {
  const time = new Intl.DateTimeFormat("pt-BR", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit"
  }).format(match.kickoff);
  const provider = match.broadcast?.name ?? "broadcast unknown";
  const free = match.broadcast?.free ? " [FREE]" : "";
  const source = match.broadcast?.source ? ` via ${match.broadcast.source}` : "";
  return `${time} — ${match.home} vs ${match.away} (${match.competition}) — Location: ${matchLocation(match)} — ${provider}${free}${source}`;
}
