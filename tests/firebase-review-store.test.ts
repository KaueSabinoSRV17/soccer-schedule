import assert from 'node:assert/strict';
import test from 'node:test';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import type { Messaging } from 'firebase-admin/messaging';
import { createDailyReview } from '../src/daily-review.js';
import { FirebaseReviewStore } from '../src/firebase-review-store.js';
import { processSubmission, type CalendarWriter } from '../src/review-workflow.js';

if (process.env.FIRESTORE_EMULATOR_HOST && !/^(127\.0\.0\.1|localhost):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) {
  throw new Error('Firestore integration tests require a loopback emulator host');
}
const integration = { skip: !process.env.FIRESTORE_EMULATOR_HOST };
test('Firestore transaction accepts one submission, rejects invalid owner, and supports idempotent retry', integration, async () => {
  if (!getApps().length) initializeApp({ projectId: 'demo-soccer-schedule' });
  const db = getFirestore();
  const reviewId = '2099-01-01';
  const ref = db.doc(`dailyReviews/${reviewId}`);
  const fixture = (id: number, hour: number) => ({ fixtureId: id, leagueId: 1, competition: 'Test', home: 'A', away: 'B', kickoff: new Date(Date.UTC(2099, 0, 1, hour)) });
  const review = createDailyReview([fixture(1, 12), fixture(2, 13)], reviewId);
  await ref.set({ ...review, status: 'ready' });
  const payload = { reviewRevision: 1, selectedIds: [1], skippedGroupIds: [], ownerEmail: 'owner@example.test', status: 'pending', createdAt: Timestamp.now() };
  const store = new FirebaseReviewStore(db, {} as Messaging);
  await ref.collection('submissions').doc('invalid').set({ ...payload, ownerEmail: 'other@example.test' });
  let writes = 0; let fail = true;
  const calendar: CalendarWriter = { sync: async () => { writes++; if (fail) throw new Error('temporary'); }, removeLegacyConflicts: async () => {} };
  await processSubmission(store, calendar, reviewId, 'invalid', 'owner@example.test');
  assert.equal((await ref.collection('submissions').doc('invalid').get()).data()!.status, 'rejected');
  assert.equal((await ref.get()).data()!.acceptedSubmissionId, undefined);
  await ref.collection('submissions').doc('first').set(payload);
  await assert.rejects(processSubmission(store, calendar, reviewId, 'first', 'owner@example.test'));
  assert.equal((await ref.get()).data()!.acceptedSubmissionId, 'first');
  await ref.collection('submissions').doc('second').set({ ...payload, selectedIds: [2] });
  await processSubmission(store, calendar, reviewId, 'second', 'owner@example.test');
  assert.equal((await ref.collection('submissions').doc('second').get()).data()!.status, 'rejected');
  fail = false;
  await processSubmission(store, calendar, reviewId, 'first', 'owner@example.test');
  await processSubmission(store, calendar, reviewId, 'first', 'owner@example.test');
  assert.equal(writes, 2);
  assert.equal((await ref.collection('submissions').doc('first').get()).data()!.status, 'synced');
});
test('reconciliation lists only retryable submissions in creation order', integration, async () => {
  const db = getFirestore();
  const id = '2099-01-05';
  const ref = db.collection(`dailyReviews/${id}/submissions`);
  await ref.doc('early').set({ status: 'pending' });
  await ref.doc('done').set({ status: 'synced' });
  await ref.doc('later').set({ status: 'failed' });
  const store = new FirebaseReviewStore(db, {} as Messaging);
  assert.deepEqual(await store.retryableSubmissionIds(id), ['early', 'later']);
});
test('concurrent publishers have one preparation owner', integration, async () => {
  const db = getFirestore();
  const one = new FirebaseReviewStore(db, {} as Messaging);
  const two = new FirebaseReviewStore(db, {} as Messaging);
  const id = '2099-01-02'; await db.doc(`dailyReviews/${id}`).delete();
  const doc = createDailyReview([], id);
  const attempts = await Promise.allSettled([one.ensureReview(id, doc), two.ensureReview(id, doc)]);
  assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
});
test('daily notification targets owner installations once and removes invalid FIDs', integration, async () => {
  const db = getFirestore();
  process.env.SOCCER_OWNER_EMAIL = 'owner@example.test';
  const id = '2099-01-03';
  const review = createDailyReview([], id);
  const ref = db.doc(`dailyReviews/${id}`);
  await ref.set({ ...review, status: 'ready' });
  const device = (fid: string, ownerEmail = 'owner@example.test') => ({ fid, ownerEmail, enabled: true });
  await db.doc('devices/good').set(device('good-fid'));
  await db.doc('devices/stale').set(device('stale-fid'));
  await db.doc('devices/other-owner').set(device('other-fid', 'other@example.test'));
  const deliveries: string[][] = [];
  const messaging = { sendEachForMulticast: async (message: { fids: string[]; data: { reviewId: string } }) => {
    deliveries.push(message.fids);
    assert.equal(message.data.reviewId, id);
    return { responses: message.fids.map(fid => fid === 'stale-fid'
      ? { success: false, error: { code: 'messaging/installation-id-not-registered' } }
      : { success: true }) };
  } } as unknown as Messaging;
  const store = new FirebaseReviewStore(db, messaging);
  await store.notifyOnce(id, 0);
  await store.notifyOnce(id, 0);
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0]!.sort(), ['good-fid', 'stale-fid']);
  assert.equal((await db.doc('devices/stale').get()).exists, false);
  assert.ok((await ref.get()).data()!.notificationSentAt);
});
test('a day with only invalid installations remains eligible for notification after registration', integration, async () => {
  const db = getFirestore();
  process.env.SOCCER_OWNER_EMAIL = 'owner@example.test';
  const devices = await db.collection('devices').get();
  await Promise.all(devices.docs.map(doc => doc.ref.delete()));
  const id = '2099-01-04';
  const ref = db.doc(`dailyReviews/${id}`);
  await ref.set({ ...createDailyReview([], id), status: 'ready' });
  await db.doc('devices/old-phone').set({ fid: 'old', enabled: true, ownerEmail: 'owner@example.test' });
  let valid = false; let sends = 0;
  const store = new FirebaseReviewStore(db, { sendEachForMulticast: async () => {
    sends++;
    return { responses: [{ success: valid, ...(valid ? {} : { error: { code: 'messaging/installation-id-not-registered' } }) }] };
  } } as unknown as Messaging);
  await store.notifyOnce(id, 0);
  assert.equal((await ref.get()).data()!.notificationSentAt, undefined);
  await db.doc('devices/new-phone').set({ fid: 'new', enabled: true, ownerEmail: 'owner@example.test' });
  valid = true;
  await store.notifyOnce(id, 0);
  assert.equal(sends, 2);
  assert.ok((await ref.get()).data()!.notificationSentAt);
});
