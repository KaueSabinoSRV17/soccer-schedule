import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { google, type calendar_v3 } from "googleapis";
import type { Match } from "./model.js";
import { matchLocation } from "./calendar.js";

export const calendarScope = "https://www.googleapis.com/auth/calendar.events";
export const defaultCredentialsPath = "secrets/google-calendar-oauth.json";
export const defaultTokenPath = "data/google-calendar-token.json";
const eventDurationMs = 135 * 60 * 1000;

interface InstalledCredentials {
  installed?: { client_id: string; client_secret: string };
  web?: { client_id: string; client_secret: string };
}

interface StoredToken {
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
}

export async function saveRefreshToken(
  credentialsPath: string,
  tokenPath: string,
  refreshToken: string
): Promise<void> {
  const keys = JSON.parse(await readFile(credentialsPath, "utf8")) as InstalledCredentials;
  const client = keys.installed ?? keys.web;
  if (!client) throw new Error("OAuth credentials must contain an installed or web client");
  const token: StoredToken = {
    type: "authorized_user",
    client_id: client.client_id,
    client_secret: client.client_secret,
    refresh_token: refreshToken
  };
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, JSON.stringify(token, null, 2), { encoding: "utf8", mode: 0o600 });
}

async function authorizedCalendar(tokenPath: string): Promise<calendar_v3.Calendar> {
  let token: StoredToken;
  try {
    token = JSON.parse(await readFile(tokenPath, "utf8")) as StoredToken;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Google Calendar is not authorized. Run npm run calendar:authorize first.`);
    }
    throw error;
  }
  const auth = new google.auth.OAuth2(token.client_id, token.client_secret);
  auth.setCredentials({ refresh_token: token.refresh_token });
  return google.calendar({ version: "v3", auth });
}

function description(match: Match): string {
  const lines = [match.competition];
  if (match.broadcast) {
    lines.push(`Watch on ${match.broadcast.name}`);
    if (match.broadcast.url) lines.push(match.broadcast.url);
  }
  return lines.join("\n");
}

export function googleEventId(match: Match): string {
  return `soccer${match.fixtureId}`;
}

export function eventResource(match: Match, timezone: string): calendar_v3.Schema$Event {
  const end = new Date(match.kickoff.getTime() + eventDurationMs);
  return {
    id: googleEventId(match),
    status: "confirmed",
    summary: `${match.home} vs ${match.away}`,
    location: matchLocation(match),
    description: description(match),
    start: { dateTime: match.kickoff.toISOString(), timeZone: timezone },
    end: { dateTime: end.toISOString(), timeZone: timezone },
    ...(match.broadcast?.url ? { source: { title: `Watch on ${match.broadcast.name}`, url: match.broadcast.url } } : {}),
    extendedProperties: {
      private: {
        soccerHeadsUp: "true",
        theSportsDbEventId: String(match.fixtureId)
      }
    }
  };
}

export interface SyncResult {
  created: number;
  updated: number;
  links: string[];
}

export async function syncMatchesToGoogleCalendar(
  matches: Match[],
  options: { calendarId: string; timezone: string; tokenPath?: string },
  calendarClient?: calendar_v3.Calendar
): Promise<SyncResult> {
  const calendar = calendarClient ?? await authorizedCalendar(options.tokenPath ?? defaultTokenPath);
  const result: SyncResult = { created: 0, updated: 0, links: [] };
  for (const match of matches) {
    const eventId = googleEventId(match);
    const request = {
      calendarId: options.calendarId,
      eventId,
      requestBody: eventResource(match, options.timezone)
    };
    try {
      const existing = await calendar.events.get({ calendarId: options.calendarId, eventId });
      const updated = await calendar.events.update(request);
      result.updated += 1;
      const link = updated.data.htmlLink ?? existing.data.htmlLink;
      if (link) result.links.push(link);
    } catch (error) {
      const status = (error as { code?: number; response?: { status?: number } }).code
        ?? (error as { response?: { status?: number } }).response?.status;
      if (status !== 404) throw error;
      try {
        const created = await calendar.events.insert({ calendarId: options.calendarId, requestBody: eventResource(match, options.timezone) });
        result.created += 1;
        if (created.data.htmlLink) result.links.push(created.data.htmlLink);
      } catch (insertError) {
        const code = (insertError as { code?: number; response?: { status?: number } }).code ?? (insertError as { response?: { status?: number } }).response?.status;
        if (code !== 409) throw insertError;
        const updated = await calendar.events.update(request);
        result.updated += 1;
        if (updated.data.htmlLink) result.links.push(updated.data.htmlLink);
      }
    }
  }
  return result;
}

/** Removes only future events carrying this collector's exact ownership metadata. */
export async function removeManagedFutureConflicts(matches: Match[], options: { calendarId: string; timezone: string; tokenPath?: string }, calendarClient?: calendar_v3.Calendar): Promise<void> {
  const calendar = calendarClient ?? await authorizedCalendar(options.tokenPath ?? defaultTokenPath);
  for (const match of matches) {
    if (match.kickoff.getTime() <= Date.now()) continue;
    const eventId = googleEventId(match);
    try {
      const existing = await calendar.events.get({ calendarId: options.calendarId, eventId });
      const metadata = existing.data.extendedProperties?.private;
      if (metadata?.soccerHeadsUp !== "true" || metadata.theSportsDbEventId !== String(match.fixtureId)) continue;
      const starts = Date.parse(existing.data.start?.dateTime ?? "");
      if (!Number.isFinite(starts) || starts <= Date.now()) continue;
      await calendar.events.delete({ calendarId: options.calendarId, eventId });
    } catch (error) {
      const status = (error as { code?: number; response?: { status?: number } }).code ?? (error as { response?: { status?: number } }).response?.status;
      if (status !== 404 && status !== 410) throw error;
    }
  }
}
