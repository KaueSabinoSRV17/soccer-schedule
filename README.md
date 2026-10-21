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
- With `--include-conflicts`, keeps all unfinished matches, including overlapping games, without prompting.
- Filters finished matches before broadcast lookup, conflict prompts and calendar output.

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

## Google Calendar synchronization

Create a Google OAuth Desktop client with the Calendar API enabled and place its downloaded JSON at:

```text
secrets/google-calendar-oauth.json
```

Authorize once on a machine with a browser:

```sh
npm run calendar:authorize
```

The refresh credential is stored with owner-only permissions in `data/google-calendar-token.json`. Both the OAuth client and token are ignored by Git. Then create or update the selected matches directly in your primary calendar:

```sh
npm run dev -- --sync-calendar
```

To use another calendar:

```sh
npm run dev -- --sync-calendar --calendar-id 'calendar-id@group.calendar.google.com'
```

`GOOGLE_CALENDAR_ID`, `GOOGLE_CALENDAR_CREDENTIALS`, and `GOOGLE_CALENDAR_TOKEN` can override the defaults. Events use stable IDs derived from TheSportsDB event IDs, so running the command again updates existing events instead of duplicating them. The app requests only the `calendar.events` OAuth scope.

To sync all unfinished matches without resolving overlaps:

```sh
npm run dev -- --full-calendar-sync
```

`--full-calendar-sync` combines `--include-conflicts` and `--sync-calendar`. For an ICS file containing all unfinished matches without direct Google synchronization, use `--include-conflicts` alone. `--non-interactive` keeps its existing behavior of choosing one match per conflict.

TheSportsDB's `strStatus` is preserved. Finished codes (`FT`, `AET`, `PEN`) and finished text labels exclude a match regardless of kickoff time. When status is missing or blank, the app assumes a match has finished 135 minutes after kickoff. An explicit live, upcoming or unrecognized status takes precedence over that estimate. See [TheSportsDB status documentation](https://www.thesportsdb.com/docs_api_data_guide).

Finished matches are omitted from new ICS files and Google Calendar create/update requests. Previously synchronized Google events remain as calendar history. If every match is finished, the app writes an empty ICS file.

Specific date or unattended job:

```sh
npm run dev -- --date 2026-10-20
npm run dev -- --non-interactive --output out/today.ics
npm run dev -- --non-interactive --sync-calendar
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

## Container and Cloud Run Job

Build the Linux AMD64 image required by this deployment:

```sh
docker build --platform linux/amd64 -t soccer-schedule:local .
docker run --rm --network none soccer-schedule:local --help
```

The build runs the TypeScript build and test suite. The final image contains production dependencies, compiled application code and broadcast configuration, and runs as the unprivileged `node` user. The build context allowlist excludes local credentials, environment files, Git metadata and generated output.

The default command is `node dist/src/cli.js --full-calendar-sync`. It performs one collection and synchronization run and exits, as a Cloud Run **Job** expects; it does not start an HTTP server. Command-line arguments replace the default arguments:

```sh
docker run --rm \
  --env THESPORTSDB_API_KEY \
  --env YOUTUBE_API_KEY \
  --env GOOGLE_CALENDAR_TOKEN=/var/secrets/google-calendar-token/token.json \
  --mount "type=bind,src=$(pwd)/data/google-calendar-token.json,dst=/var/secrets/google-calendar-token/token.json,readonly" \
  soccer-schedule:local --full-calendar-sync
```

For Cloud Run, inject `THESPORTSDB_API_KEY` and `YOUTUBE_API_KEY` from Secret Manager and mount the existing Google Calendar refresh-token JSON at the path specified by `GOOGLE_CALENDAR_TOKEN`. `SOCCER_TIMEZONE` defaults to `America/Sao_Paulo`; `GOOGLE_CALENDAR_ID` defaults to `primary`. The mounted token must be readable by the container user. Google Calendar authorization is completed separately, before execution. ICS files under `/app/out` are temporary container output; Google Calendar events persist remotely.

The adjacent infrastructure repository expects this image path:

```text
southamerica-east1-docker.pkg.dev/PROJECT_ID/soccer-schedule/soccer-schedule:latest
```

Its collector currently overrides the image arguments with `--non-interactive --sync-calendar`. Change those arguments to `["--full-calendar-sync"]` in `modules/collector/main.tf` to retain all overlapping games. After publishing an image, enable `deploy_job` in `live/config.hcl` and apply the collector configuration. Publishing an image alone does not deploy or update the Job; use `SOCCER_IMAGE` with the published commit SHA tag when applying infrastructure for a specific release.

## GitHub Actions publishing

[The container workflow](.github/workflows/container.yml) builds and tests on pull requests targeting `main`. Pushes to `main`, or manual runs on `main`, additionally publish the validated image to Artifact Registry with the full commit SHA and `latest` tags. Other manual runs only build and validate. The workflow does not execute the application against live APIs or deploy the Cloud Run Job.

Create these **repository Actions variables** under Settings → Secrets and variables → Actions → Variables:

| Variable | Value |
| --- | --- |
| `GCP_PROJECT_ID` | Your existing Google Cloud project ID |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/providers/PROVIDER` |
| `GCP_SERVICE_ACCOUNT` | Email of the service account used by GitHub to publish images |
| `GCP_REGION` | Optional; defaults to `southamerica-east1` |
| `GAR_REPOSITORY` | Optional; defaults to `soccer-schedule` |

Authentication uses [Google's Workload Identity Federation action](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account), without storing a service account key in GitHub. The existing infrastructure does not yet create the GitHub federation or publishing service account. Configure these in the infrastructure repository before the first publishing run:

1. Create a Workload Identity Pool and OIDC provider for `https://token.actions.githubusercontent.com`, mapping `google.subject=assertion.sub` and `attribute.repository=assertion.repository`.
2. Restrict the provider attribute condition to `assertion.repository == 'KaueSabinoSRV17/soccer-schedule' && assertion.ref == 'refs/heads/main'`.
3. Create a dedicated publishing service account. Grant it `roles/artifactregistry.writer` on the `soccer-schedule` Artifact Registry repository.
4. Grant `roles/iam.workloadIdentityUser` on that service account to `principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/POOL/attribute.repository/KaueSabinoSRV17/soccer-schedule`.
5. Enable the IAM Service Account Credentials and Security Token Service APIs, and fill in the required Actions variables above.

Application API keys and Calendar tokens belong in Secret Manager at runtime; this workflow does not need them.

## Validate

```sh
npm test
npm run check
npm run build
```

The core can run from cron, a container, a scheduled function, or CI. A fully unattended interactive service will need a notification adapter (email, Telegram, web UI, etc.) for choices and Google OAuth for direct calendar insertion; both can be added without changing fixture collection or selection.
