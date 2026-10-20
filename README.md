# Soccer Heads-up

A provider-neutral Node.js/TypeScript app that fetches today's matches and Brazilian TV listings from TheSportsDB, lets you resolve overlapping games, and produces a calendar containing the selected matches and viewing links.

It follows LaLiga, Premier League, Ligue 1, Bundesliga, Brasileirão Série A, Italian Serie A, UEFA Champions League, and Copa Libertadores.

## Current behavior

- Fetches event ID, competition, UTC kickoff, and home/away teams from TheSportsDB.
- Fetches Brazil-filtered TV listings from TheSportsDB and joins them by the shared event ID.
- Resolves providers through a hybrid chain: fixture override, trusted YouTube channels, TheSportsDB TV listings, an optional extra listings API, then a competition fallback.
- Puts free YouTube broadcasts first (for example, CazéTV and Ge TV).
- Prompts when assumed 2h15 match windows overlap.
- Generates an `.ics` file plus one-click Google Calendar URLs with viewing links.
- With `--non-interactive`, automatically chooses the highest-priority conflicting match.

TheSportsDB provides broadcaster names but usually not exact viewing URLs. `channel_urls` maps those names to official platform destinations, while the YouTube adapter discovers exact upcoming/live video links.

## Set up and run

Requires Node.js 20 or newer.

```sh
npm install
cp .env.example .env
cp config/broadcasts.example.json config/broadcasts.json
export THESPORTSDB_API_KEY='your-premium-key'
export YOUTUBE_API_KEY='your-google-api-key'
export SOCCER_TIMEZONE='America/Sao_Paulo'
npm run dev
```

Specific date or unattended job:

```sh
npm run dev -- --date 2026-10-20
npm run dev -- --non-interactive --output out/today.ics
```

Fixture entries in `config/broadcasts.json` override all providers. Use the TheSportsDB event ID as the key. Import the `.ics` file into Google Calendar or open the printed one-click URLs.

Copy `config/broadcasts.example.json` to `config/broadcasts.json` to enable searches on the configured trusted channels. `YOUTUBE_API_KEY` must belong to a Google Cloud project with YouTube Data API v3 enabled. The resolver fetches each trusted channel's live and upcoming broadcasts once and only accepts a result whose title identifies both teams and whose scheduled start is within six hours of kickoff. Searches are restricted to configured channels; arbitrary YouTube uploads are never trusted. Channel order in the configuration is precedence order.

Resolution order is:

1. Exact fixture override in `fixtures`.
2. Live/upcoming video from `youtube_channels`.
3. Brazil-specific TheSportsDB TV listing, preferring names in `free_channels` and resolving destinations through `channel_urls`.
4. `BROADCAST_LISTINGS_URL`, when configured as an optional supplementary source.
5. `competition_defaults`, marked as low confidence.

Provider failures are non-fatal and produce a warning, allowing the remaining providers to run.

### Broadcast listings adapter

`BROADCAST_LISTINGS_URL` can point to a licensed service or a self-hosted adapter. The app adds `date=YYYY-MM-DD` and `timezone=IANA_ZONE` query parameters. The endpoint must return JSON in this neutral format:

```json
[
  {
    "home": "Flamengo",
    "away": "Palmeiras",
    "provider": "Premiere",
    "url": "https://provider.example/watch/123",
    "free": false
  }
]
```

This isolates any provider-specific authentication or response mapping behind a small HTTP adapter.

## Validate

```sh
npm test
npm run check
npm run build
```

The core can run from cron, a container, a scheduled function, or CI. A fully unattended interactive service will need a notification adapter (email, Telegram, web UI, etc.) for choices and Google OAuth for direct calendar insertion; both can be added without changing fixture collection or selection.
