export interface Broadcast {
  name: string;
  url?: string;
  free: boolean;
  source?: "manual" | "youtube" | "thesportsdb" | "listings" | "default";
  confidence?: "high" | "medium" | "low";
}

export interface Match {
  fixtureId: number;
  leagueId: number;
  competition: string;
  kickoff: Date;
  home: string;
  away: string;
  broadcast?: Broadcast;
}

