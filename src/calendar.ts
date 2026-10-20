import type { Match } from "./model.js";

const eventDurationMs = 135 * 60 * 1000;

function compactUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function escapeIcs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function details(match: Match): string {
  if (!match.broadcast) return match.competition;
  const link = match.broadcast.url ? `: ${match.broadcast.url}` : "";
  return `${match.competition}\nWatch on ${match.broadcast.name}${link}`;
}

export function matchLocation(match: Match): string {
  return match.venue ? `${match.venue} (${match.home})` : match.home;
}

export function googleCalendarUrl(match: Match): string {
  const end = new Date(match.kickoff.getTime() + eventDurationMs);
  const query = new URLSearchParams({
    action: "TEMPLATE",
    text: `${match.home} vs ${match.away}`,
    dates: `${compactUtc(match.kickoff)}/${compactUtc(end)}`,
    details: details(match),
    location: matchLocation(match)
  });
  return `https://calendar.google.com/calendar/render?${query}`;
}

export function asIcs(matches: Match[]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Soccer Heads-up//EN", "CALSCALE:GREGORIAN"];
  for (const match of matches) {
    const end = new Date(match.kickoff.getTime() + eventDurationMs);
    lines.push(
      "BEGIN:VEVENT",
      `UID:thesportsdb-${match.fixtureId}@soccer-headsup`,
      `DTSTAMP:${compactUtc(new Date())}`,
      `DTSTART:${compactUtc(match.kickoff)}`,
      `DTEND:${compactUtc(end)}`,
      `SUMMARY:${escapeIcs(`${match.home} vs ${match.away}`)}`,
      `LOCATION:${escapeIcs(matchLocation(match))}`,
      `DESCRIPTION:${escapeIcs(details(match))}`
    );
    if (match.broadcast?.url) lines.push(`URL:${match.broadcast.url}`);
    lines.push("END:VEVENT");
  }
  return [...lines, "END:VCALENDAR", ""].join("\r\n");
}

