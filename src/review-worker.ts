import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { firebaseReviewStore, configuredOwnerEmail } from './firebase-review-store.js';
import { processSubmission } from './review-workflow.js';
import { reviewCalendarWriter } from './review-calendar.js';

export const processReviewSubmission = onDocumentCreated({
  document: 'dailyReviews/{reviewId}/submissions/{submissionId}',
  region: 'southamerica-east1', retry: true, maxInstances: 1, concurrency: 1,
  timeoutSeconds: 300, memory: '512MiB',
}, async event => {
  await processReviewCreation(event, (reviewId, submissionId) =>
    processSubmission(firebaseReviewStore(), reviewCalendarWriter(), reviewId, submissionId, configuredOwnerEmail()));
});

export async function processReviewCreation(
  event: { params: { reviewId?: string; submissionId?: string }; data?: unknown },
  process: (reviewId: string, submissionId: string) => Promise<void>,
): Promise<void> {
  // The authoritative document is read in a transaction. An omitted Eventarc
  // snapshot must not silently acknowledge an unprocessed submission.
  if (!event.params?.reviewId || !event.params?.submissionId) {
    throw new Error('Firestore submission event is missing path parameters');
  }
  if (!event.data) console.info('Firestore submission event has no snapshot; loading document by path');
  await process(event.params.reviewId, event.params.submissionId);
}
