import assert from 'node:assert/strict';
import test from 'node:test';
import { processReviewCreation } from '../src/review-worker.js';

test('a created submission is processed even without an Eventarc snapshot', async () => {
  const calls: string[][] = [];
  await processReviewCreation(
    { params: { reviewId: '2026-10-26', submissionId: 'choice-1' } },
    async (reviewId, submissionId) => { calls.push([reviewId, submissionId]); },
  );
  assert.deepEqual(calls, [['2026-10-26', 'choice-1']]);
});

test('an event without a submission path fails so Eventarc can retry', async () => {
  await assert.rejects(
    processReviewCreation({ params: { reviewId: '2026-10-26' } }, async () => {}),
    /missing path parameters/,
  );
});
