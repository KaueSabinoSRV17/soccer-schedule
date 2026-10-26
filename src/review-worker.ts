import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { firebaseReviewStore, configuredOwnerEmail } from './firebase-review-store.js';
import { processSubmission } from './review-workflow.js';
import { reviewCalendarWriter } from './review-calendar.js';

export const processReviewSubmission = onDocumentCreated({
  document: 'dailyReviews/{reviewId}/submissions/{submissionId}',
  region: 'southamerica-east1', retry: true, maxInstances: 1, concurrency: 1,
  timeoutSeconds: 300, memory: '512MiB',
}, async event => {
  if (!event.data) return;
  await processSubmission(firebaseReviewStore(), reviewCalendarWriter(), event.params.reviewId, event.params.submissionId, configuredOwnerEmail());
});
