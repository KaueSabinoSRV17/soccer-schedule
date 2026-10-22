import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadBroadcastConfig, resolveBroadcasts } from "./broadcast.js";
import { asIcs, googleCalendarUrl } from "./calendar.js";
import { competitionIds } from "./config.js";
import type { Match } from "./model.js";
import { chooseSchedule, unfinishedMatches } from "./planner.js";
import { TheSportsDbClient } from "./thesportsdb.js";
import { syncMatchesToGoogleCalendar } from "./google-calendar.js";
import { displayMatch } from "./presentation.js";

interface Options {
  date: string;
  timezone: string;
  broadcasts: string;
  output: string;
  nonInteractive: boolean;
  includeConflicts: boolean;
  syncCalendar: boolean;
  calendarId: string;
}

function localIsoDate(): string {
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: process.env.SOCCER_TIMEZONE ?? "America/Sao_Paulo" });
  return formatter.format(new Date());
}

function parseArgs(args: string[]): Options {
  const options: Options = {
    date: localIsoDate(),
    timezone: process.env.SOCCER_TIMEZONE ?? "America/Sao_Paulo",
    broadcasts: "config/broadcasts.json",
    output: "",
    nonInteractive: false,
    includeConflicts: false,
    syncCalendar: false,
    calendarId: process.env.GOOGLE_CALENDAR_ID ?? "primary"
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--non-interactive") options.nonInteractive = true;
    else if (argument === "--include-conflicts") options.includeConflicts = true;
    else if (argument === "--full-calendar-sync") {
      options.includeConflicts = true;
      options.syncCalendar = true;
    }
    else if (argument === "--sync-calendar") options.syncCalendar = true;
    else if (argument === "--calendar-id") options.calendarId = requiredValue(args, ++index, argument);
    else if (argument === "--date") options.date = requiredValue(args, ++index, argument);
    else if (argument === "--timezone") options.timezone = requiredValue(args, ++index, argument);
    else if (argument === "--broadcasts") options.broadcasts = requiredValue(args, ++index, argument);
    else if (argument === "--output") options.output = requiredValue(args, ++index, argument);
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: soccer-headsup [--date YYYY-MM-DD] [--timezone IANA_ZONE] [--broadcasts FILE] [--output FILE] [--non-interactive] [--include-conflicts] [--sync-calendar] [--full-calendar-sync] [--calendar-id ID]");
      process.exit(0);
    } else throw new Error(`Unknown option: ${argument}`);
  }
  options.output ||= `out/${options.date}.ics`;
  return options;
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.THESPORTSDB_API_KEY;
  if (!apiKey) throw new Error("THESPORTSDB_API_KEY is required");

  const client = new TheSportsDbClient(apiKey);
  const [fixtures, tvEvents] = await Promise.all([
    client.fixtures(options.date, competitionIds, options.timezone),
    client.tvSchedule(options.date, "Brazil")
  ]);
  const eligibleFixtures = unfinishedMatches(fixtures);
  const skipped = fixtures.length - eligibleFixtures.length;
  if (skipped > 0) console.log(`Skipped ${skipped} finished match(es).`);
  const config = await loadBroadcastConfig(options.broadcasts);
  const matches = eligibleFixtures.length === 0 ? [] : await resolveBroadcasts(eligibleFixtures, config, {
    youtubeApiKey: process.env.YOUTUBE_API_KEY,
    listingsUrl: process.env.BROADCAST_LISTINGS_URL,
    day: options.date,
    timezone: options.timezone,
    sportsDbTvEvents: tvEvents,
    warn: (message) => console.warn(message)
  });
  if (matches.length === 0) {
    console.log(`No unfinished matches in configured competitions on ${options.date}.`);
  }

  const terminal = createInterface({ input: stdin, output: stdout });
  const ask = options.nonInteractive
    ? async (choices: Match[]) => choices[0]!
    : async (choices: Match[]) => {
        console.log("\nThese matches overlap. Which one do you want to watch?");
        choices.forEach((match, index) => console.log(`  ${index + 1}. ${displayMatch(match, options.timezone)}`));
        while (true) {
          const selected = Number(await terminal.question("Choice: "));
          if (Number.isInteger(selected) && choices[selected - 1]) return choices[selected - 1]!;
          console.log(`Enter a number from 1 to ${choices.length}.`);
        }
      };

  try {
    const selected = await chooseSchedule(matches, ask, { includeConflicts: options.includeConflicts });
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, asIcs(selected), "utf8");
    if (options.syncCalendar) {
      const synced = await syncMatchesToGoogleCalendar(selected, {
        calendarId: options.calendarId,
        timezone: options.timezone,
        tokenPath: process.env.GOOGLE_CALENDAR_TOKEN
      });
      console.log(`Google Calendar synced: ${synced.created} created, ${synced.updated} updated.`);
    }
    console.log(`\nSelected ${selected.length} match(es); calendar saved to ${options.output}:`);
    for (const match of selected) {
      console.log(`\n${displayMatch(match, options.timezone)}`);
      console.log(`  Add to Google Calendar: ${googleCalendarUrl(match)}`);
    }
  } finally {
    terminal.close();
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
