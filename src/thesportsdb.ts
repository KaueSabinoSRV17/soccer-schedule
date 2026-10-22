import type { Match } from "./model.js";

interface SportsDbEvent {
  idEvent: string;
  idLeague: string;
  strLeague: string;
  strTimestamp: string | null;
  dateEvent: string;
  strTime: string | null;
  strHomeTeam: string;
  strAwayTeam: string;
  strVenue?: string | null;
  strStatus?: string | null;
}

interface EventsResponse {
  events: SportsDbEvent[] | null;
}

export interface SportsDbTvEvent {
  idEvent: string;
  strCountry: string | null;
  strChannel: string;
  idChannel?: string;
  strLogo?: string | null;
}

interface TvResponse {
  tvevents: SportsDbTvEvent[] | null;
}

type Fetch = typeof fetch;

export class TheSportsDbError extends Error {}

export class TheSportsDbClient {
  private readonly baseUrl: string;

  constructor(private readonly apiKey: string, private readonly fetchImpl: Fetch = fetch) {
    this.baseUrl = `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(apiKey)}`;
  }

  private async get<T>(path: string, query: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}/${path}`);
    url.search = new URLSearchParams(query).toString();
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
    } catch (error) {
      throw new TheSportsDbError(`TheSportsDB request failed: ${String(error)}`);
    }
    if (!response.ok) throw new TheSportsDbError(`TheSportsDB returned HTTP ${response.status}`);
    return await response.json() as T;
  }

  async fixtures(day: string, leagueIds: ReadonlySet<number>, timezone = "UTC"): Promise<Match[]> {
    const date = new Date(`${day}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) {
      throw new TheSportsDbError(`Invalid fixture date: ${day}`);
    }
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit"
    });
    // A local calendar day can cross UTC midnight. Query both neighboring
    // dates, then use the actual kickoff to select the requested local day.
    const days = [-1, 0, 1].map((offset) =>
      new Date(date.getTime() + offset * 86_400_000).toISOString().slice(0, 10)
    );
    const payloads = await Promise.all(days.map((d) =>
      this.get<EventsResponse>("eventsday.php", { d, s: "Soccer" })
    ));
    const events = new Map(payloads.flatMap((payload) => payload.events ?? [])
      .map((event) => [event.idEvent, event]));
    return [...events.values()]
      .filter((event) => leagueIds.has(Number(event.idLeague)))
      .map((event) => ({
        fixtureId: Number(event.idEvent),
        leagueId: Number(event.idLeague),
        competition: event.strLeague,
        kickoff: parseUtcKickoff(event),
        home: event.strHomeTeam,
        away: event.strAwayTeam,
        ...(event.strStatus?.trim() ? { status: event.strStatus.trim() } : {}),
        ...(event.strVenue?.trim() ? { venue: event.strVenue.trim() } : {})
      }))
      .filter((match) => formatter.format(match.kickoff) === day)
      .sort((left, right) => left.kickoff.getTime() - right.kickoff.getTime());
  }

  async tvSchedule(day: string, country = "Brazil"): Promise<SportsDbTvEvent[]> {
    const payload = await this.get<TvResponse>("eventstv.php", { d: day, s: "Soccer", a: country });
    return payload.tvevents ?? [];
  }
}

function parseUtcKickoff(event: SportsDbEvent): Date {
  const value = event.strTimestamp ?? `${event.dateEvent}T${event.strTime ?? "00:00:00"}`;
  const explicitZone = /(?:Z|[+-]\d\d:\d\d)$/.test(value);
  const parsed = new Date(explicitZone ? value : `${value}Z`);
  if (Number.isNaN(parsed.getTime())) throw new TheSportsDbError(`Invalid kickoff for event ${event.idEvent}: ${value}`);
  return parsed;
}
