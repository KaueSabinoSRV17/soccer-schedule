import type { Match } from "./model.js";

const matchWindowMs = 135 * 60 * 1000;

function isFreeYouTube(match: Match): boolean {
  return Boolean(match.broadcast?.free && match.broadcast.url?.toLowerCase().includes("youtube.com"));
}

export function byPriority(left: Match, right: Match): number {
  const freeDifference = Number(!isFreeYouTube(left)) - Number(!isFreeYouTube(right));
  return freeDifference || left.kickoff.getTime() - right.kickoff.getTime();
}

export function overlaps(left: Match, right: Match): boolean {
  const leftStart = left.kickoff.getTime();
  const rightStart = right.kickoff.getTime();
  return leftStart < rightStart + matchWindowMs && rightStart < leftStart + matchWindowMs;
}

export async function chooseSchedule(
  matches: Match[],
  ask: (options: Match[]) => Promise<Match>
): Promise<Match[]> {
  let remaining = [...matches].sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());
  const chosen: Match[] = [];
  while (remaining.length > 0) {
    const candidate = remaining.shift()!;
    const conflicts = remaining.filter((item) => overlaps(candidate, item));
    if (conflicts.length === 0) {
      chosen.push(candidate);
      continue;
    }
    const winner = await ask([candidate, ...conflicts].sort(byPriority));
    chosen.push(winner);
    remaining = remaining.filter((item) => item !== winner && !overlaps(winner, item));
  }
  return chosen.sort((a, b) => a.kickoff.getTime() - b.kickoff.getTime());
}

