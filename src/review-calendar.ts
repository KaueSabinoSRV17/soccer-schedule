import { removeManagedFutureConflicts, syncMatchesToGoogleCalendar } from './google-calendar.js';
import type { CalendarWriter } from './review-workflow.js';

export function reviewCalendarWriter(configuration: { calendarId?: string } = {}): CalendarWriter {
  const options = { calendarId: configuration.calendarId ?? process.env.GOOGLE_CALENDAR_ID ?? 'primary', timezone: 'America/Sao_Paulo', tokenPath: process.env.GOOGLE_CALENDAR_TOKEN };
  return {
    sync: async matches => { if (matches.length) await syncMatchesToGoogleCalendar(matches, options); },
    removeLegacyConflicts: async matches => { if (matches.length) await removeManagedFutureConflicts(matches, options); },
  };
}
