import assert from 'node:assert/strict';
import test from 'node:test';
import { createDailyReview, InvalidChoiceError } from '../src/daily-review.js';
import { processSubmission, publishReview, type CalendarWriter, type ReviewRecord, type ReviewStore, type Submission } from '../src/review-workflow.js';
import type { Match } from '../src/model.js';

const matches: Match[] = [0, 100, 200, 600].map((minute, index) => ({ fixtureId: index + 1, leagueId: 1, competition: 'League', home: 'A', away: 'B', kickoff: new Date(Date.UTC(2099, 0, 1, 12, minute)) }));
const now = new Date('2099-01-01T06:00:00Z');
class Store implements ReviewStore {
  record: ReviewRecord = { ...createDailyReview(matches, '2099-01-01', now), status: 'preparing' };
  submission: Submission = { reviewRevision: 1, selectedIds: [1, 3], skippedGroupIds: [], ownerEmail: 'owner@example.test', createdAt: now, status: 'pending' };
  invalid = false;
  finished: string[] = [];
  notices = 0;
  async ensureReview() { return this.record; }
  async markReady() { this.record.status = 'ready'; }
  async claimSubmission() {
    if (this.invalid) throw new InvalidChoiceError('Invalid owner');
    if (this.submission.status === 'synced') return null;
    return { review: this.record, submission: this.submission };
  }
  async finishSubmission(_r: string, _s: string, status: 'synced' | 'rejected' | 'failed') { this.submission.status = status; this.finished.push(status); }
  async notifyOnce() { this.notices++; }
}
function writer() {
  const calls: Array<{ action: string; ids: number[] }> = [];
  const calendar: CalendarWriter = {
    sync: async selected => { calls.push({ action: 'sync', ids: selected.map(m => m.fixtureId) }); },
    removeLegacyConflicts: async selected => { calls.push({ action: 'remove', ids: selected.map(m => m.fixtureId) }); },
  };
  return { calls, calendar };
}
test('publishes automatic matches, removes only future conflicts and marks ready before notification', async () => {
  const store = new Store(); const { calls, calendar } = writer();
  await publishReview(store, calendar, matches, '2099-01-01', now);
  assert.deepEqual(calls, [{ action: 'remove', ids: [1, 2, 3] }, { action: 'sync', ids: [4] }]);
  assert.equal(store.record.status, 'ready');
  await publishReview(store, calendar, matches, '2099-01-01', now);
  assert.equal(calls.length, 2, 'a ready review never repeats conflict cleanup');
});
test('failed publication stays preparing and never notifies', async () => {
  const store = new Store(); const { calendar } = writer();
  calendar.sync = async () => { throw new Error('Calendar offline'); };
  await assert.rejects(publishReview(store, calendar, matches, '2099-01-01', now));
  assert.equal(store.record.status, 'preparing'); assert.equal(store.notices, 0);
});
test('successful choices synchronize compatible endpoints; replay is ignored', async () => {
  const store = new Store(); const { calls, calendar } = writer();
  await processSubmission(store, calendar, '2099-01-01', 's1', 'owner@example.test');
  assert.deepEqual(calls, [{ action: 'sync', ids: [1, 3] }]);
  assert.deepEqual(store.finished, ['synced']);
  await processSubmission(store, calendar, '2099-01-01', 's1', 'owner@example.test');
  assert.equal(calls.length, 1);
});
test('permanent validation errors are rejected without Calendar calls or retries', async () => {
  const store = new Store(); store.invalid = true; const { calls, calendar } = writer();
  await processSubmission(store, calendar, '2099-01-01', 's1', 'owner@example.test');
  assert.deepEqual(store.finished, ['rejected']); assert.deepEqual(calls, []);
});
test('transient Calendar errors are surfaced for retry using the same selections', async () => {
  const store = new Store(); const { calls, calendar } = writer();
  const original = calendar.sync; calendar.sync = async () => { throw new Error('Calendar offline'); };
  await assert.rejects(processSubmission(store, calendar, '2099-01-01', 's1', 'owner@example.test'));
  assert.deepEqual(store.finished, ['failed']);
  calendar.sync = original;
  await processSubmission(store, calendar, '2099-01-01', 's1', 'owner@example.test');
  assert.deepEqual(calls, [{ action: 'sync', ids: [1, 3] }]);
  assert.deepEqual(store.finished, ['failed', 'synced']);
});
