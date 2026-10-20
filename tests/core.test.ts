import assert from "node:assert/strict";
import { test } from "node:test";
import { asIcs, googleCalendarUrl } from "../src/calendar.js";
import { findSportsDbBroadcasts, findYouTubeBroadcasts, resolveBroadcasts, titleMatchesFixture } from "../src/broadcast.js";
import type { Match } from "../src/model.js";
import { chooseSchedule } from "../src/planner.js";
import { TheSportsDbClient } from "../src/thesportsdb.js";

function fixture(id: number, hour: number, free = false): Match {
  return {
    fixtureId: id,
    leagueId: 4328,
    competition: "Premier League",
    kickoff: new Date(`2026-10-20T${String(hour).padStart(2, "0")}:00:00Z`),
    home: `Home ${id}`,
    away: `Away ${id}`,
    ...(free ? { broadcast: { name: "CazéTV", url: "https://youtube.com/watch?v=x", free: true } } : {})
  };
}

test("free YouTube is the first conflict option", async () => {
  let seen: Match[] = [];
  const selected = await chooseSchedule([fixture(1, 18), fixture(2, 18, true)], async (options) => {
    seen = options;
    return options[0]!;
  });
  assert.equal(seen[0]?.fixtureId, 2);
  assert.deepEqual(selected.map((item) => item.fixtureId), [2]);
});

test("non-overlapping matches are retained", async () => {
  const selected = await chooseSchedule([fixture(1, 10), fixture(2, 13)], async (options) => options[0]!);
  assert.deepEqual(selected.map((item) => item.fixtureId), [1, 2]);
});

test("calendar contains home side and stream link", () => {
  const item = fixture(2, 18, true);
  assert.match(asIcs([item]), /LOCATION:Home 2 \(home\)/);
  assert.match(asIcs([item]), /URL:https:\/\/youtube.com\/watch\?v=x/);
  assert.match(googleCalendarUrl(item), /calendar\.google\.com\/calendar\/render/);
});

test("YouTube title matching ignores accents and common club suffixes", () => {
  const item = { ...fixture(3, 18), home: "São Paulo FC", away: "Flamengo" };
  assert.equal(titleMatchesFixture("AO VIVO: SAO PAULO x FLAMENGO", item), true);
  assert.equal(titleMatchesFixture("São Paulo x Palmeiras", item), false);
});

test("trusted YouTube channel resolves a direct stream URL", async () => {
  const fetchMock: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const items = url.pathname.endsWith("/videos")
      ? [{
          id: "live123",
          snippet: { title: "Home 1 x Away 1 AO VIVO", channelTitle: "CazéTV" },
          liveStreamingDetails: { scheduledStartTime: "2026-10-20T18:00:00Z" }
        }]
      : [{
          id: { videoId: "live123" },
          snippet: { title: "Home 1 x Away 1 AO VIVO", channelTitle: "CazéTV", liveBroadcastContent: "upcoming" }
        }];
    return new Response(JSON.stringify({ items }), { status: 200 });
  };
  const found = await findYouTubeBroadcasts(
    [fixture(1, 18)],
    [{ name: "CazéTV", channel_id: "trusted", free: true }],
    "key",
    fetchMock
  );
  assert.equal(found.get(1)?.url, "https://www.youtube.com/watch?v=live123");
  assert.equal(found.get(1)?.source, "youtube");
});

test("manual fixture override wins over dynamic providers and defaults", async () => {
  const [resolved] = await resolveBroadcasts([fixture(1, 18)], {
    fixtures: { "1": { name: "Manual", url: "https://manual.test", free: false } },
    competition_defaults: { "4328": { name: "Default", free: false } }
  }, { day: "2026-10-20", timezone: "America/Sao_Paulo" });
  assert.equal(resolved?.broadcast?.name, "Manual");
  assert.equal(resolved?.broadcast?.source, "manual");
});

test("TheSportsDB client filters configured leagues and treats timestamps as UTC", async () => {
  const fetchMock: typeof fetch = async () => new Response(JSON.stringify({ events: [
    {
      idEvent: "2594560", idLeague: "4480", strLeague: "UEFA Champions League",
      strTimestamp: "2026-10-20T19:00:00", dateEvent: "2026-10-20", strTime: "19:00:00",
      strHomeTeam: "Paris Saint-Germain", strAwayTeam: "Barcelona"
    },
    {
      idEvent: "1", idLeague: "9999", strLeague: "Other", strTimestamp: "2026-10-20T20:00:00",
      dateEvent: "2026-10-20", strTime: "20:00:00", strHomeTeam: "Other A", strAwayTeam: "Other B"
    }
  ] }), { status: 200 });
  const matches = await new TheSportsDbClient("secret", fetchMock).fixtures("2026-10-20", new Set([4480]));
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.fixtureId, 2594560);
  assert.equal(matches[0]?.kickoff.toISOString(), "2026-10-20T19:00:00.000Z");
});

test("TheSportsDB TV matching uses event IDs and prioritizes configured free channels", () => {
  const found = findSportsDbBroadcasts([fixture(1, 18)], [
    { idEvent: "1", strCountry: "Brazil", strChannel: "Premiere" },
    { idEvent: "1", strCountry: "Brazil", strChannel: "Globo" }
  ], {
    free_channels: ["Globo"],
    channel_urls: { Globo: "https://globoplay.example/live" }
  });
  assert.equal(found.get(1)?.name, "Globo");
  assert.equal(found.get(1)?.free, true);
  assert.equal(found.get(1)?.url, "https://globoplay.example/live");
});
