export interface Competition {
  id: number;
  name: string;
}

export const competitions: Competition[] = [
  { id: 4335, name: "LaLiga" },
  { id: 4328, name: "Premier League" },
  { id: 4334, name: "Ligue 1" },
  { id: 4331, name: "Bundesliga" },
  { id: 4351, name: "Brasileirão Série A" },
  { id: 4332, name: "Serie A" },
  { id: 4480, name: "UEFA Champions League" },
  { id: 4501, name: "Copa Libertadores" }
];

export const competitionIds = new Set(competitions.map(({ id }) => id));

