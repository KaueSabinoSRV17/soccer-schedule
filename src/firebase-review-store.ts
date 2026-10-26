import { randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';
import { InvalidChoiceError, validateChoices, type DailyReviewDocument } from './daily-review.js';
import type { ReviewRecord, ReviewStore, Submission } from './review-workflow.js';

export class FirebaseReviewStore implements ReviewStore {
  private readonly executionId = process.env.CLOUD_RUN_EXECUTION ?? randomUUID();
  constructor(private readonly db: Firestore, private readonly messaging: Messaging) {}

  async ensureReview(id: string, review: DailyReviewDocument): Promise<ReviewRecord> {
    const ref = this.db.doc(`dailyReviews/${id}`);
    return this.db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.data();
      if (current?.status === 'ready') return current as ReviewRecord;
      if (current?.preparationOwner !== this.executionId && current?.preparationLease instanceof Timestamp && current.preparationLease.toMillis() > Date.now()) {
        throw new Error('Another collector execution is preparing this review');
      }
      const record = current ? current as ReviewRecord : { ...review, status: 'preparing' as const };
      transaction.set(ref, { ...record, preparationOwner: this.executionId, preparationLease: Timestamp.fromMillis(Date.now() + 15 * 60_000) });
      return record;
    });
  }

  async markReady(id: string): Promise<void> {
    const ref = this.db.doc(`dailyReviews/${id}`);
    const pointer = this.db.doc('state/current');
    await this.db.runTransaction(async transaction => {
      const [review, state] = await Promise.all([transaction.get(ref), transaction.get(pointer)]);
      if (review.data()?.preparationOwner !== this.executionId) throw new Error('Review preparation ownership changed');
      transaction.update(ref, { status: 'ready', preparationLease: FieldValue.delete(), preparationOwner: FieldValue.delete() });
      const currentId = state.data()?.reviewId;
      if (typeof currentId !== 'string' || currentId <= id) transaction.set(pointer, { reviewId: id, updatedAt: FieldValue.serverTimestamp() });
    });
  }

  async claimSubmission(reviewId: string, submissionId: string, ownerEmail: string): Promise<{ review: ReviewRecord; submission: Submission } | null> {
    const reviewRef = this.db.doc(`dailyReviews/${reviewId}`);
    const submissionRef = reviewRef.collection('submissions').doc(submissionId);
    return this.db.runTransaction(async transaction => {
      const [reviewSnapshot, submissionSnapshot] = await Promise.all([transaction.get(reviewRef), transaction.get(submissionRef)]);
      if (!submissionSnapshot.exists) return null;
      const raw = submissionSnapshot.data()!;
      if (raw.status === 'synced' || raw.status === 'rejected') return null;
      if (!ownerEmail || raw.ownerEmail?.toLowerCase() !== ownerEmail.toLowerCase()) throw new InvalidChoiceError('Account not authorized');
      if (!(raw.createdAt instanceof Timestamp)) throw new InvalidChoiceError('Invalid server timestamp');
      if (!['pending', 'processing', 'failed'].includes(raw.status)) throw new InvalidChoiceError('Invalid submission status');
      const review = reviewSnapshot.data() as ReviewRecord | undefined;
      if (!review || review.status !== 'ready') throw new InvalidChoiceError('Review is not ready');
      if (review.acceptedSubmissionId && review.acceptedSubmissionId !== submissionId) throw new InvalidChoiceError('This review already has an accepted submission');
      const submission = { ...raw, createdAt: raw.createdAt.toDate() } as Submission;
      validateChoices(review, submission, submission.createdAt);
      transaction.update(reviewRef, { acceptedSubmissionId: submissionId });
      transaction.update(submissionRef, { status: 'processing', updatedAt: FieldValue.serverTimestamp(), error: FieldValue.delete() });
      return { review, submission };
    });
  }

  async finishSubmission(reviewId: string, submissionId: string, status: 'synced' | 'rejected' | 'failed', message?: string): Promise<void> {
    await this.db.doc(`dailyReviews/${reviewId}/submissions/${submissionId}`).update({
      status, updatedAt: FieldValue.serverTimestamp(), error: message ?? FieldValue.delete(),
    });
  }

  async retryableSubmissionIds(reviewId: string): Promise<string[]> {
    const snapshot = await this.db.collection(`dailyReviews/${reviewId}/submissions`).get();
    return snapshot.docs
      .filter(doc => ['pending', 'failed'].includes(doc.data().status))
      .sort((left, right) => left.createTime.toMillis() - right.createTime.toMillis())
      .map(doc => doc.id);
  }

  async notifyOnce(reviewId: string, pendingGroups: number): Promise<void> {
    const ref = this.db.doc(`dailyReviews/${reviewId}`);
    const claimed = await this.db.runTransaction(async transaction => {
      const snapshot = await transaction.get(ref);
      const data = snapshot.data();
      if (data?.notificationSentAt) return false;
      if (data?.notificationOwner !== this.executionId && data?.notificationLease instanceof Timestamp && data.notificationLease.toMillis() > Date.now()) throw new Error('Daily notification is already being sent');
      transaction.update(ref, { notificationOwner: this.executionId, notificationLease: Timestamp.fromMillis(Date.now() + 120_000) });
      return true;
    });
    if (!claimed) return;
    const devices = await this.db.collection('devices').where('enabled', '==', true).get();
    const entries = devices.docs.filter(doc => typeof doc.data().fid === 'string' && doc.data().ownerEmail === configuredOwnerEmail());
    if (!entries.length) {
      await ref.update({ notificationOwner: FieldValue.delete(), notificationLease: FieldValue.delete() });
      return;
    }
    let transientFailure = false;
    let accepted = false;
    for (let start = 0; start < entries.length; start += 500) {
      const chunk = entries.slice(start, start + 500);
      const response = await this.messaging.sendEachForMulticast({
        fids: chunk.map(doc => doc.data().fid as string),
        notification: { title: 'Sua análise de futebol está pronta', body: pendingGroups ? `${pendingGroups} grupos de jogos precisam da sua escolha.` : 'Os jogos sem conflito já estão na sua agenda.' },
        data: { type: 'daily_review', reviewId },
        android: { priority: 'high', collapseKey: `review-${reviewId}`, notification: { tag: `review-${reviewId}`, channelId: 'daily_review', icon: 'ic_stat_soccer' } },
      });
      for (const [index, item] of response.responses.entries()) {
        if (item.success) { accepted = true; continue; }
        if (['messaging/installation-id-not-registered', 'messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(item.error?.code ?? '')) await chunk[index]!.ref.delete();
        else transientFailure = true;
      }
    }
    if (transientFailure) {
      await ref.update({ notificationOwner: FieldValue.delete(), notificationLease: FieldValue.delete() });
      throw new Error('Some daily notification deliveries need retrying');
    }
    if (!accepted) {
      await ref.update({ notificationOwner: FieldValue.delete(), notificationLease: FieldValue.delete() });
      return;
    }
    await ref.update({ notificationSentAt: FieldValue.serverTimestamp(), notificationOwner: FieldValue.delete(), notificationLease: FieldValue.delete() });
  }
}

export function configuredOwnerEmail(): string {
  const owner = process.env.SOCCER_OWNER_EMAIL?.trim().toLowerCase();
  if (!owner || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(owner)) throw new Error('SOCCER_OWNER_EMAIL must identify the sole authorized owner');
  return owner;
}

export function firebaseReviewStore(): FirebaseReviewStore {
  configuredOwnerEmail();
  if (!getApps().length) initializeApp();
  return new FirebaseReviewStore(getFirestore(), getMessaging());
}
