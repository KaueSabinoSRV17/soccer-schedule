import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadBroadcastConfig, resolveBroadcasts } from "./broadcast.js";
import { asIcs, googleCalendarUrl } from "./calendar.js";
import { competitionIds } from "./config.js";
import type { Match } from "./model.js";
import { chooseSchedule } from "./planner.js";
import { TheSportsDbClient } from "./thesportsdb.js";

interface Options {
  date: string;
  timezone: string;
  broadcasts: string;
  output: string;
  nonInteractive: boolean;
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
    nonInteractive: false
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--non-interactive") options.nonInteractive = true;
    else if (argument === "--date") options.date = requiredValue(args, ++index, argument);
    else if (argument === "--timezone") options.timezone = requiredValue(args, ++index, argument);
    else if (argument === "--broadcasts") options.broadcasts = requiredValue(args, ++index, argument);
    else if (argument === "--output") options.output = requiredValue(args, ++index, argument);
    else if (argument === "--help" || argument === "-h") {
      console.log("Usage: soccer-headsup [--date YYYY-MM-DD] [--timezone IANA_ZONE] [--broadcasts FILE] [--output FILE] [--non-interactive]");
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

function display(match: Match, timezone: string): string {
  const time = new Intl.DateTimeFormat("pt-BR", { timeZone: timezone, hour: "2-digit", minute: "2-digit" }).format(match.kickoff);
  const provider = match.broadcast?.name ?? "broadcast unknown";
  const free = match.broadcast?.free ? " [FREE]" : "";
  const source = match.broadcast?.source ? ` via ${match.broadcast.source}` : "";
  return `${time} — ${match.home} vs ${match.away} (${match.competition}) — ${provider}${free}${source}`;
}

async function run(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.THESPORTSDB_API_KEY;
  if (!apiKey) throw new Error("THESPORTSDB_API_KEY is required");

  const client = new TheSportsDbClient(apiKey);
  const [fixtures, tvEvents] = await Promise.all([
    client.fixtures(options.date, competitionIds),
    client.tvSchedule(options.date, "Brazil")
  ]);
  const config = await loadBroadcastConfig(options.broadcasts);
  const matches = await resolveBroadcasts(fixtures, config, {
    youtubeApiKey: process.env.YOUTUBE_API_KEY,
    listingsUrl: process.env.BROADCAST_LISTINGS_URL,
    day: options.date,
    timezone: options.timezone,
    sportsDbTvEvents: tvEvents,
    warn: (message) => console.warn(message)
  });
  if (matches.length === 0) {
    console.log(`No configured competition has a match on ${options.date}.`);
    return;
  }

  const terminal = createInterface({ input: stdin, output: stdout });
  const ask = options.nonInteractive
    ? async (choices: Match[]) => choices[0]!
    : async (choices: Match[]) => {
        console.log("\nThese matches overlap. Which one do you want to watch?");
        choices.forEach((match, index) => console.log(`  ${index + 1}. ${display(match, options.timezone)}`));
        while (true) {
          const selected = Number(await terminal.question("Choice: "));
          if (Number.isInteger(selected) && choices[selected - 1]) return choices[selected - 1]!;
          console.log(`Enter a number from 1 to ${choices.length}.`);
        }
      };

  try {
    const selected = await chooseSchedule(matches, ask);
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, asIcs(selected), "utf8");
    console.log(`\nSelected ${selected.length} match(es); calendar saved to ${options.output}:`);
    for (const match of selected) {
      console.log(`\n${display(match, options.timezone)}`);
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
