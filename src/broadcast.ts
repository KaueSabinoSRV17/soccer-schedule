import { readFile } from "node:fs/promises";
import type { Broadcast, Match } from "./model.js";
import type { SportsDbTvEvent } from "./thesportsdb.js";

export interface YouTubeChannel {
  name: string;
  handle?: string;
  channel_id?: string;
  free?: boolean;
}

export interface BroadcastConfig {
  fixtures?: Record<string, Broadcast>;
  youtube_channels?: YouTubeChannel[];
  channel_urls?: Record<string, string>;
  free_channels?: string[];
  competition_defaults?: Record<string, Broadcast>;
}

export interface Listing {
  home: string;
  away: string;
  provider: string;
  url?: string;
  free?: boolean;
}

interface YouTubeSearchItem {
  id: { videoId?: string };
  snippet: { title: string; channelTitle: string; liveBroadcastContent?: string };
}

interface YouTubeVideo {
  id: string;
  snippet: { title: string; channelTitle: string };
  liveStreamingDetails?: { scheduledStartTime?: string; actualStartTime?: string };
}

type Fetch = typeof fetch;

export async function loadBroadcastConfig(path?: string): Promise<BroadcastConfig> {
  if (!path) return {};
  try {
    return JSON.parse(await readFile(path, "utf8")) as BroadcastConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function normalized(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const ignoredTeamWords = new Set(["fc", "cf", "ac", "sc", "ec", "club", "futebol", "football", "de", "da", "do"]);

function teamMatches(text: string, team: string): boolean {
  const whole = normalized(team);
  if (text.includes(whole)) return true;
  const meaningful = whole.split(" ").filter((word) => word.length >= 4 && !ignoredTeamWords.has(word));
  return meaningful.length > 0 && meaningful.some((word) => text.split(" ").includes(word));
}

export function titleMatchesFixture(title: string, match: Match): boolean {
  const text = normalized(title);
  return teamMatches(text, match.home) && teamMatches(text, match.away);
}

async function getJson<T>(url: URL, fetchImpl: Fetch): Promise<T> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Broadcast provider returned HTTP ${response.status}`);
  return await response.json() as T;
}

async function resolveChannelId(channel: YouTubeChannel, apiKey: string, fetchImpl: Fetch): Promise<string | undefined> {
  if (channel.channel_id) return channel.channel_id;
  if (!channel.handle) return undefined;
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.search = new URLSearchParams({ part: "id", forHandle: channel.handle, key: apiKey }).toString();
  const payload = await getJson<{ items?: Array<{ id: string }>; error?: { message?: string } }>(url, fetchImpl);
  if (payload.error) throw new Error(`YouTube API: ${payload.error.message ?? "unknown error"}`);
  return payload.items?.[0]?.id;
}

async function channelStreams(channelId: string, apiKey: string, fetchImpl: Fetch): Promise<YouTubeVideo[]> {
  const searches = (["live", "upcoming"] as const).map(async (eventType) => {
    const url = new URL("https://www.googleapis.com/youtube/v3/search");
    url.search = new URLSearchParams({ part: "snippet", channelId, eventType, type: "video", maxResults: "50", key: apiKey }).toString();
    const payload = await getJson<{ items?: YouTubeSearchItem[]; error?: { message?: string } }>(url, fetchImpl);
    if (payload.error) throw new Error(`YouTube API: ${payload.error.message ?? "unknown error"}`);
    return payload.items ?? [];
  });
  const results = (await Promise.all(searches)).flat();
  const ids = [...new Set(results.flatMap((item) => item.id.videoId ? [item.id.videoId] : []))];
  const videos: YouTubeVideo[] = [];
  for (let index = 0; index < ids.length; index += 50) {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.search = new URLSearchParams({
      part: "snippet,liveStreamingDetails",
      id: ids.slice(index, index + 50).join(","),
      key: apiKey
    }).toString();
    const payload = await getJson<{ items?: YouTubeVideo[]; error?: { message?: string } }>(url, fetchImpl);
    if (payload.error) throw new Error(`YouTube API: ${payload.error.message ?? "unknown error"}`);
    videos.push(...(payload.items ?? []));
  }
  return videos;
}

function streamMatchesFixture(stream: YouTubeVideo, match: Match): boolean {
  if (!titleMatchesFixture(stream.snippet.title, match)) return false;
  const startText = stream.liveStreamingDetails?.scheduledStartTime ?? stream.liveStreamingDetails?.actualStartTime;
  if (!startText) return false;
  return Math.abs(new Date(startText).getTime() - match.kickoff.getTime()) <= 6 * 60 * 60 * 1000;
}

export async function findYouTubeBroadcasts(
  matches: Match[], channels: YouTubeChannel[], apiKey: string, fetchImpl: Fetch = fetch
): Promise<Map<number, Broadcast>> {
  const found = new Map<number, Broadcast>();
  for (const channel of channels) {
    const channelId = await resolveChannelId(channel, apiKey, fetchImpl);
    if (!channelId) continue;
    const streams = await channelStreams(channelId, apiKey, fetchImpl);
    for (const match of matches) {
      const stream = streams.find((item) => streamMatchesFixture(item, match));
      if (stream && !found.has(match.fixtureId)) {
        found.set(match.fixtureId, {
          name: channel.name || stream.snippet.channelTitle,
          url: `https://www.youtube.com/watch?v=${stream.id}`,
          free: channel.free ?? true,
          source: "youtube",
          confidence: "high"
        });
      }
    }
  }
  return found;
}

export async function findListingBroadcasts(
  matches: Match[], endpoint: string, day: string, timezone: string, fetchImpl: Fetch = fetch
): Promise<Map<number, Broadcast>> {
  const url = new URL(endpoint);
  url.searchParams.set("date", day);
  url.searchParams.set("timezone", timezone);
  const listings = await getJson<Listing[]>(url, fetchImpl);
  const found = new Map<number, Broadcast>();
  for (const match of matches) {
    const listing = listings.find((item) => teamMatches(normalized(item.home), match.home) && teamMatches(normalized(item.away), match.away));
    if (listing) {
      found.set(match.fixtureId, {
        name: listing.provider,
        ...(listing.url ? { url: listing.url } : {}),
        free: listing.free ?? false,
        source: "listings",
        confidence: "high"
      });
    }
  }
  return found;
}

export interface ResolveBroadcastOptions {
  youtubeApiKey?: string;
  listingsUrl?: string;
  day: string;
  timezone: string;
  sportsDbTvEvents?: SportsDbTvEvent[];
  fetchImpl?: Fetch;
  warn?: (message: string) => void;
}

export async function resolveBroadcasts(matches: Match[], config: BroadcastConfig, options: ResolveBroadcastOptions): Promise<Match[]> {
  const resolved = new Map<number, Broadcast>();
  for (const match of matches) {
    const manual = config.fixtures?.[String(match.fixtureId)];
    if (manual) resolved.set(match.fixtureId, { ...manual, source: "manual", confidence: "high" });
  }

  const unresolved = () => matches.filter((match) => !resolved.has(match.fixtureId));
  if (options.youtubeApiKey && config.youtube_channels?.length) {
    try {
      const youtube = await findYouTubeBroadcasts(unresolved(), config.youtube_channels, options.youtubeApiKey, options.fetchImpl);
      youtube.forEach((broadcast, fixtureId) => resolved.set(fixtureId, broadcast));
    } catch (error) {
      options.warn?.(`YouTube lookup skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (options.sportsDbTvEvents?.length && unresolved().length) {
    const sportsDb = findSportsDbBroadcasts(unresolved(), options.sportsDbTvEvents, config);
    sportsDb.forEach((broadcast, fixtureId) => resolved.set(fixtureId, broadcast));
  }
  if (options.listingsUrl && unresolved().length) {
    try {
      const listings = await findListingBroadcasts(unresolved(), options.listingsUrl, options.day, options.timezone, options.fetchImpl);
      listings.forEach((broadcast, fixtureId) => resolved.set(fixtureId, broadcast));
    } catch (error) {
      options.warn?.(`Broadcast listings lookup skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return matches.map((match) => {
    const broadcast = resolved.get(match.fixtureId) ?? config.competition_defaults?.[String(match.leagueId)];
    return broadcast
      ? { ...match, broadcast: broadcast.source ? broadcast : { ...broadcast, source: "default", confidence: "low" } }
      : match;
  });
}

export function findSportsDbBroadcasts(
  matches: Match[], tvEvents: SportsDbTvEvent[], config: BroadcastConfig
): Map<number, Broadcast> {
  const found = new Map<number, Broadcast>();
  const freeChannels = new Set((config.free_channels ?? []).map(normalized));
  const urlByChannel = new Map(Object.entries(config.channel_urls ?? {}).map(([name, url]) => [normalized(name), url]));
  for (const match of matches) {
    const candidates = tvEvents.filter((event) => Number(event.idEvent) === match.fixtureId);
    candidates.sort((left, right) => Number(!freeChannels.has(normalized(left.strChannel))) - Number(!freeChannels.has(normalized(right.strChannel))));
    const selected = candidates[0];
    if (!selected) continue;
    const channelKey = normalized(selected.strChannel);
    const url = urlByChannel.get(channelKey);
    found.set(match.fixtureId, {
      name: selected.strChannel,
      ...(url ? { url } : {}),
      free: freeChannels.has(channelKey),
      source: "thesportsdb",
      confidence: "high"
    });
  }
  return found;
}
