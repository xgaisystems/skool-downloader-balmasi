/**
 * Date and time formatting utilities adhering to the European standard (dd/mm/aaaa).
 */

export function sanitizeName(value: string) {
    // Windows drops trailing dots and spaces from folder names, so "Title..." would not resolve.
    return value.replace(/[/\\?%*:|"<>]/g, '-').replace(/[. ]+$/, '');
}

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * Formats a date into European format: dd/mm/aaaa (e.g. 01/10/2026).
 *
 * @param date Date, ISO string, timestamp or undefined. Defaults to current date if omitted.
 * @returns Formatted date string in dd/mm/aaaa format, or empty string if date is invalid/null.
 */
export function formatDate(date: Date | string | number = new Date()): string {
    if (!date) return '';
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return '';
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
}

/**
 * Formats a date and time into European format: dd/mm/aaaa HH:mm:ss or dd/mm/aaaa HH:mm.
 *
 * @param date Date, ISO string, timestamp or undefined.
 * @param includeSeconds Whether to include seconds (default: true).
 * @returns Formatted date-time string in European format, or 'unknown time' if invalid.
 */
export function formatDateTime(date?: Date | string | number | null, includeSeconds = true): string {
    if (!date) return 'unknown time';
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return 'unknown time';
    const datePart = formatDate(d);
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    if (includeSeconds) {
        const seconds = String(d.getSeconds()).padStart(2, '0');
        return `${datePart} ${hours}:${minutes}:${seconds}`;
    }
    return `${datePart} ${hours}:${minutes}`;
}
