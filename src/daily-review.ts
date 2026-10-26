import { createHash } from 'node:crypto';
import type { Match } from './model.js';
import { overlaps } from './planner.js';

export const reviewSchemaVersion = 1;
export interface StoredFixture extends Omit<Match, 'kickoff'> { kickoff: string }
export interface ReviewGroup { id: string; fixtureIds: number[] }
export interface DailyReviewDocument {
  schemaVersion: 1;
  revision: number;
  date: string;
  timezone: 'America/Sao_Paulo';
  generatedAt: string;
  fixtures: StoredFixture[];
  automaticIds: number[];
  conflictGroups: ReviewGroup[];
  fingerprint: string;
}
export interface ChoiceDocument {
  reviewRevision: number;
  selectedIds: number[];
  skippedGroupIds: string[];
}
export class InvalidChoiceError extends Error {}

function compare(left: Match, right: Match): number {
  return left.kickoff.getTime() - right.kickoff.getTime() || left.fixtureId - right.fixtureId;
}

export function partitionFixtures(matches: Match[]): { automatic: Match[]; groups: Match[][] } {
  const ids = matches.map(m => m.fixtureId);
  if (new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error('Fixture IDs must be positive, unique safe integers');
  }
  if (matches.some(match => !Number.isFinite(match.kickoff.getTime()))) throw new Error('Invalid kickoff');
  const remaining = new Set([...matches].sort(compare));
  const groups: Match[][] = [];
  const automatic: Match[] = [];
  while (remaining.size) {
    const first = remaining.values().next().value!;
    remaining.delete(first);
    const component = [first];
    for (let index = 0; index < component.length; index++) {
      for (const candidate of [...remaining]) {
        if (overlaps(component[index]!, candidate)) {
          component.push(candidate);
          remaining.delete(candidate);
        }
      }
    }
    component.sort(compare);
    if (component.length === 1) automatic.push(first);
    else groups.push(component);
  }
  return { automatic, groups };
}

export function createDailyReview(matches: Match[], date: string, now = new Date()): DailyReviewDocument {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Invalid review date');
  const { automatic, groups } = partitionFixtures(matches);
  // Explicit fields avoid accidentally persisting provider credentials or internals.
  const fixtures: StoredFixture[] = [...matches].sort(compare).map(match => ({
    fixtureId: match.fixtureId, leagueId: match.leagueId, competition: match.competition,
    kickoff: match.kickoff.toISOString(), home: match.home, away: match.away,
    ...(match.venue ? { venue: match.venue } : {}),
    ...(match.status ? { status: match.status } : {}),
    ...(match.broadcast ? { broadcast: {
      name: match.broadcast.name, free: match.broadcast.free,
      ...(match.broadcast.url ? { url: match.broadcast.url } : {}),
      ...(match.broadcast.source ? { source: match.broadcast.source } : {}),
      ...(match.broadcast.confidence ? { confidence: match.broadcast.confidence } : {}),
    } } : {}),
  }));
  return {
    schemaVersion: reviewSchemaVersion, revision: 1, date,
    timezone: 'America/Sao_Paulo', generatedAt: now.toISOString(), fixtures,
    automaticIds: automatic.map(match => match.fixtureId),
    conflictGroups: groups.map(group => ({ id: group.map(match => match.fixtureId).join('-'), fixtureIds: group.map(match => match.fixtureId) })),
    fingerprint: createHash('sha256').update(JSON.stringify(fixtures)).digest('hex'),
  };
}

export function validateChoices(review: DailyReviewDocument, input: unknown, submittedAt: Date): Match[] {
  const fail = (message: string): never => { throw new InvalidChoiceError(message); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Invalid submission');
  const choices = input as Record<string, unknown>;
  if (choices.reviewRevision !== review.revision) return fail('Review revision changed');
  if (!Array.isArray(choices.selectedIds) || !Array.isArray(choices.skippedGroupIds) ||
      choices.selectedIds.length > 100 || choices.skippedGroupIds.length > 100) return fail('Invalid choices');
  const selectedIds = choices.selectedIds as unknown[];
  const skipped = choices.skippedGroupIds as unknown[];
  if (selectedIds.some(id => typeof id !== 'number' || !Number.isSafeInteger(id)) || skipped.some(id => typeof id !== 'string')) return fail('Invalid choice types');
  if (new Set(selectedIds).size !== selectedIds.length || new Set(skipped).size !== skipped.length) return fail('Duplicate choices');
  const matches: Match[] = review.fixtures.map(fixture => ({ ...fixture, kickoff: new Date(fixture.kickoff) }));
  const partition = partitionFixtures(matches);
  // Derive groups from authoritative fixtures; never trust group membership sent by a client.
  const groups = partition.groups.map(group => ({ id: group.map(match => match.fixtureId).join('-'), matches: group }));
  const conflictIds = new Set(groups.flatMap(group => group.matches.map(match => match.fixtureId)));
  if (selectedIds.some(id => !conflictIds.has(id as number))) return fail('Unknown or automatic fixture');
  if (skipped.some(id => !groups.some(group => group.id === id))) return fail('Unknown conflict group');
  for (const group of groups) {
    const chosen = group.matches.filter(match => selectedIds.includes(match.fixtureId));
    if (skipped.includes(group.id) && chosen.length) return fail('A skipped group cannot contain selections');
    if (!skipped.includes(group.id) && !chosen.length) return fail('Every conflict group needs a decision');
  }
  const selected = matches.filter(match => selectedIds.includes(match.fixtureId));
  if (!Number.isFinite(submittedAt.getTime())) return fail('Invalid submission timestamp');
  if (selected.some(match => match.kickoff.getTime() <= submittedAt.getTime())) return fail('A selected match has already started');
  if (selected.some((match, index) => selected.slice(index + 1).some(other => overlaps(match, other)))) return fail('Selected matches overlap');
  return selected.sort(compare);
}
