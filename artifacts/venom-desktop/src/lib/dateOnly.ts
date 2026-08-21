import { format } from 'date-fns';

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Formats a calendar date without interpreting it as a UTC instant.
 *
 * ECMAScript parses YYYY-MM-DD as UTC midnight, which moves the displayed day
 * backward in time zones west of UTC. Building the Date from local components
 * preserves the calendar day the API supplied.
 */
export function formatLocalDateOnly(value: string) {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return value;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const localDate = new Date(year, month - 1, day);

  if (
    localDate.getFullYear() !== year ||
    localDate.getMonth() !== month - 1 ||
    localDate.getDate() !== day
  ) {
    return value;
  }

  return format(localDate, 'MMM d');
}