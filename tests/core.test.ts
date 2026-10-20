import assert from "node:assert/strict";
import { test } from "node:test";
import { asIcs, googleCalendarUrl } from "../src/calendar.js";
import { findSportsDbBroadcasts, findYouTubeBroadcasts, resolveBroadcasts, titleMatchesFixture } from "../src/broadcast.js";
import type { Match } from "../src/model.js";
import { chooseSchedule, isMatchFinished, unfinishedMatches } from "../src/planner.js";
import { TheSportsDbClient } from "../src/thesportsdb.js";
import { eventResource, googleEventId } from "../src/google-calendar.js";
import { displayMatch } from "../src/presentation.js";

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
  const item = { ...fixture(2, 18, true), venue: "Maracanã" };
  assert.match(asIcs([item]), /LOCATION:Maracanã \(Home 2\)/);
  assert.match(asIcs([item]), /URL:https:\/\/youtube.com\/watch\?v=x/);
  assert.match(googleCalendarUrl(item), /calendar\.google\.com\/calendar\/render/);
});

test("calendar location falls back to the home team when venue is unavailable", () => {
  assert.match(asIcs([fixture(4, 20)]), /LOCATION:Home 4/);
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
      strHomeTeam: "Paris Saint-Germain", strAwayTeam: "Barcelona", strVenue: "Parc des Princes", strStatus: " FT "
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
  assert.equal(matches[0]?.venue, "Parc des Princes");
  assert.equal(matches[0]?.status, "FT");
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

test("Google Calendar events have stable IDs and viewing details", () => {
  const item = { ...fixture(42, 18, true), venue: "Home Stadium" };
  const event = eventResource(item, "America/Sao_Paulo");
  assert.equal(googleEventId(item), "soccer42");
  assert.equal(event.id, "soccer42");
  assert.equal(event.summary, "Home 42 vs Away 42");
  assert.equal(event.location, "Home Stadium (Home 42)");
  assert.match(event.description ?? "", /CazéTV/);
  assert.equal(event.source?.url, "https://youtube.com/watch?v=x");
  assert.equal(event.extendedProperties?.private?.theSportsDbEventId, "42");
});

test("conflict prompt formatter includes venue and home team", () => {
  const item = {
    ...fixture(7, 16),
    competition: "UEFA Champions League",
    home: "Paris Saint-Germain",
    away: "Barcelona",
    venue: "Parc des Princes"
  };
  assert.equal(
    displayMatch(item, "UTC"),
    "16:00 — Paris Saint-Germain vs Barcelona (UEFA Champions League) — Location: Parc des Princes (Paris Saint-Germain) — broadcast unknown"
  );
  assert.match(displayMatch(fixture(8, 18), "UTC"), /Location: Home 8/);
});


test("include-conflicts retains overlapping matches in kickoff order without asking", async () => {
  const matches = [fixture(3, 20), fixture(1, 18), fixture(2, 18, true)];
  const selected = await chooseSchedule(matches, async () => {
    assert.fail("Full schedule must not prompt");
  }, { includeConflicts: true });
  assert.deepEqual(selected.map((match) => match.fixtureId), [1, 2, 3]);
  assert.equal(matches[0]?.fixtureId, 3);
});

test("finished statuses override kickoff time", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  for (const status of ["FT", "AET", "PEN", "Match Finished", " finished ", "Match Finished After Extra Time", "Match Finished After Penalty"]) {
    assert.equal(isMatchFinished({ ...fixture(1, 18), status }, now), true, status);
  }
});

test("explicit live, upcoming and unknown statuses override elapsed time", () => {
  const now = new Date("2026-10-20T23:00:00Z");
  for (const status of ["NS", "Not Started", "1H", "HT", "2H", "ET", "P", "SUSP", "custom status"]) {
    assert.equal(isMatchFinished({ ...fixture(1, 18), status }, now), false, status);
  }
});

test("missing status uses the 135-minute boundary", () => {
  const item = fixture(1, 18);
  assert.equal(isMatchFinished(item, new Date("2026-10-20T17:00:00Z")), false);
  assert.equal(isMatchFinished(item, new Date("2026-10-20T20:14:59Z")), false);
  assert.equal(isMatchFinished(item, new Date("2026-10-20T20:15:00Z")), true);
  assert.equal(isMatchFinished({ ...item, status: "  " }, new Date("2026-10-20T20:15:00Z")), true);
});

test("finished fixtures are absent from conflict choices and calendar output", async () => {
  const matches = unfinishedMatches([
    { ...fixture(1, 18), status: "FT" }, fixture(2, 18), fixture(3, 18)
  ], new Date("2026-10-20T18:30:00Z"));
  const selected = await chooseSchedule(matches, async (choices) => {
    assert.deepEqual(choices.map((match) => match.fixtureId), [2, 3]);
    return choices[0]!;
  });
  assert.doesNotMatch(asIcs(selected), /Home 1/);
  assert.deepEqual(matches.map((match) => eventResource(match, "UTC").id), ["soccer2", "soccer3"]);
  const empty = unfinishedMatches([fixture(1, 10)], new Date("2026-10-20T23:00:00Z"));
  assert.deepEqual(empty, []);
  assert.doesNotMatch(asIcs(empty), /BEGIN:VEVENT/);
});
