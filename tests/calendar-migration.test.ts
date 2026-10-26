import assert from 'node:assert/strict';
import test from 'node:test';
import type { calendar_v3 } from 'googleapis';
import { googleEventId, removeManagedFutureConflicts, syncMatchesToGoogleCalendar } from '../src/google-calendar.js';
import type { Match } from '../src/model.js';
const match = (id: number): Match => ({ fixtureId: id, leagueId: 1, competition: 'Test', home: 'A', away: 'B', kickoff: new Date('2099-01-01T12:00:00Z') });
const options = { calendarId: 'primary', timezone: 'America/Sao_Paulo' };
test('migration removes only future events carrying both exact ownership markers', async () => {
  const deleted: string[] = [];
  const client = { events: {
    get: async ({ eventId }: { eventId: string }) => {
      if (eventId === 'soccer4') throw { code: 404 };
      return { data: { start: { dateTime: eventId === 'soccer3' ? '1970-01-01T00:00:00Z' : '2099-01-01T12:00:00Z' },
        extendedProperties: { private: eventId === 'soccer2' ? {} : { soccerHeadsUp: 'true', theSportsDbEventId: eventId.slice(6) } } } };
    },
    delete: async ({ eventId }: { eventId: string }) => { deleted.push(eventId); },
  } } as unknown as calendar_v3.Calendar;
  await removeManagedFutureConflicts([match(1), match(2), match(3), match(4)], options, client);
  assert.deepEqual(deleted, ['soccer1']);
});
test('chosen legacy events are restored with their stable IDs and confirmed status', async () => {
  let updated: calendar_v3.Params$Resource$Events$Update | undefined;
  const client = { events: {
    get: async () => ({ data: { status: 'cancelled' } }),
    update: async (request: calendar_v3.Params$Resource$Events$Update) => { updated = request; return { data: {} }; },
  } } as unknown as calendar_v3.Calendar;
  await syncMatchesToGoogleCalendar([match(1)], options, client);
  assert.equal(updated!.eventId, googleEventId(match(1)));
  assert.equal(updated!.requestBody!.status, 'confirmed');
});
test('an insert race updates the same event rather than creating a duplicate', async () => {
  let updates = 0;
  const client = { events: {
    get: async () => { throw { code: 404 }; },
    insert: async () => { throw { code: 409 }; },
    update: async () => { updates++; return { data: {} }; },
  } } as unknown as calendar_v3.Calendar;
  const result = await syncMatchesToGoogleCalendar([match(1)], options, client);
  assert.equal(updates, 1); assert.equal(result.created, 0); assert.equal(result.updated, 1);
});
