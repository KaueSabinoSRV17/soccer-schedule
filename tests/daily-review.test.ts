import assert from 'node:assert/strict';
import test from 'node:test';
import { createDailyReview, partitionFixtures, validateChoices } from '../src/daily-review.js';
import type { Match } from '../src/model.js';
const match = (fixtureId: number, minute: number): Match => ({ fixtureId, leagueId: 1, competition: 'League', home: 'A', away: 'B', kickoff: new Date(Date.UTC(2026, 9, 23, 12, minute)) });
const now = new Date('2026-10-23T06:00:00Z');
const review = () => createDailyReview([match(3, 200), match(2, 100), match(1, 0), match(4, 600)], '2026-10-23', now);

test('partitions chain conflicts while allowing compatible endpoints', () => {
  const result = review();
  assert.deepEqual(result.automaticIds, [4]);
  assert.deepEqual(result.conflictGroups, [{ id: '1-2-3', fixtureIds: [1, 2, 3] }]);
  assert.deepEqual(validateChoices(result, { reviewRevision: 1, selectedIds: [1, 3], skippedGroupIds: [] }, now).map(m => m.fixtureId), [1, 3]);
});
test('touching 135-minute endpoints are not conflicts', () => {
  assert.equal(partitionFixtures([match(1, 0), match(2, 135)]).automatic.length, 2);
});
test('same kickoff and different input ordering preserve fingerprint and IDs', () => {
  const a = createDailyReview([match(2, 0), match(1, 0)], '2026-10-23', now);
  const b = createDailyReview([match(1, 0), match(2, 0)], '2026-10-23', now);
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.conflictGroups[0]!.id, '1-2');
});
test('rejects invalid dates, duplicate fixture IDs and invalid kickoff times', () => {
  assert.throws(() => createDailyReview([], '2026-02-30', now));
  assert.throws(() => partitionFixtures([match(1, 0), match(1, 200)]));
  assert.throws(() => partitionFixtures([{ ...match(1, 0), kickoff: new Date('invalid') }]));
});
test('requires explicit decisions and rejects forged, overlapping or stale selections', () => {
  const invalid: unknown[] = [
    null, {}, { reviewRevision: 2, selectedIds: [1], skippedGroupIds: [] },
    { reviewRevision: 1, selectedIds: [1, 2], skippedGroupIds: [] },
    { reviewRevision: 1, selectedIds: [4], skippedGroupIds: [] },
    { reviewRevision: 1, selectedIds: [99], skippedGroupIds: [] },
    { reviewRevision: 1, selectedIds: ['1'], skippedGroupIds: [] },
    { reviewRevision: 1, selectedIds: [1, 1], skippedGroupIds: [] },
    { reviewRevision: 1, selectedIds: [], skippedGroupIds: [] },
    { reviewRevision: 1, selectedIds: [], skippedGroupIds: ['unknown'] },
    { reviewRevision: 1, selectedIds: [1], skippedGroupIds: ['1-2-3'] },
  ];
  for (const input of invalid) assert.throws(() => validateChoices(review(), input, now));
});
test('allows an explicitly skipped group and rejects matches started at submission time', () => {
  assert.deepEqual(validateChoices(review(), { reviewRevision: 1, selectedIds: [], skippedGroupIds: ['1-2-3'] }, now), []);
  assert.throws(() => validateChoices(review(), { reviewRevision: 1, selectedIds: [1], skippedGroupIds: [] }, new Date('2026-10-23T12:00:00Z')));
});
