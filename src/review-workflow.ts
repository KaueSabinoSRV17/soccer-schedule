import { createDailyReview, InvalidChoiceError, validateChoices, type DailyReviewDocument } from './daily-review.js';
import type { Match } from './model.js';

export type SubmissionStatus = 'pending' | 'processing' | 'synced' | 'rejected' | 'failed';
export interface Submission {
  reviewRevision: number; selectedIds: number[]; skippedGroupIds: string[];
  ownerEmail: string; createdAt: Date; status: SubmissionStatus;
}
export interface ReviewRecord extends DailyReviewDocument {
  status: 'preparing' | 'ready'; acceptedSubmissionId?: string;
}
export interface ReviewStore {
  ensureReview(id: string, review: DailyReviewDocument): Promise<ReviewRecord>;
  markReady(id: string): Promise<void>;
  claimSubmission(reviewId: string, submissionId: string, ownerEmail: string): Promise<{ review: ReviewRecord; submission: Submission } | null>;
  finishSubmission(reviewId: string, submissionId: string, status: 'synced' | 'rejected' | 'failed', message?: string): Promise<void>;
  notifyOnce(reviewId: string, pendingGroups: number): Promise<void>;
}
export interface CalendarWriter {
  sync(matches: Match[]): Promise<void>;
  removeLegacyConflicts(matches: Match[]): Promise<void>;
}

export async function publishReview(store: ReviewStore, calendar: CalendarWriter, matches: Match[], date: string, now = new Date()): Promise<void> {
  const record = await store.ensureReview(date, createDailyReview(matches, date, now));
  if (record.status !== 'ready') {
    const fixtures = record.fixtures.map(fixture => ({ ...fixture, kickoff: new Date(fixture.kickoff) }));
    const automatic = new Set(record.automaticIds);
    // Only known app-managed future conflict events are removed during migration.
    await calendar.removeLegacyConflicts(fixtures.filter(match => !automatic.has(match.fixtureId) && match.kickoff > now));
    await calendar.sync(fixtures.filter(match => automatic.has(match.fixtureId)));
    await store.markReady(date);
  }
  await store.notifyOnce(date, record.conflictGroups.length);
}

export async function processSubmission(store: ReviewStore, calendar: CalendarWriter, reviewId: string, submissionId: string, ownerEmail: string): Promise<void> {
  let claimed: Awaited<ReturnType<ReviewStore['claimSubmission']>>;
  try {
    claimed = await store.claimSubmission(reviewId, submissionId, ownerEmail);
  } catch (error) {
    if (!(error instanceof InvalidChoiceError)) throw error;
    await store.finishSubmission(reviewId, submissionId, 'rejected', error.message);
    return;
  }
  if (!claimed) return;
  try {
    const selected = validateChoices(claimed.review, claimed.submission, claimed.submission.createdAt);
    await calendar.sync(selected);
    await store.finishSubmission(reviewId, submissionId, 'synced');
  } catch (error) {
    if (error instanceof InvalidChoiceError) {
      await store.finishSubmission(reviewId, submissionId, 'rejected', error.message);
      return;
    }
    await store.finishSubmission(reviewId, submissionId, 'failed', 'Calendar synchronization will be retried.');
    throw error;
  }
}
