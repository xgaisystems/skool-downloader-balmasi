import fs from 'fs';
import path from 'path';

/**
 * Date and time formatting utilities adhering to the European standard (dd/mm/aaaa).
 */

let resolvedDownloadsDir: string | null = null;

// Where communities are downloaded and served from: SKOOL_DOWNLOADS_DIR, or
// downloads/ under the current directory. A configured folder that cannot be
// used (an unmounted share, no permission) falls back to the default with a
// warning instead of failing. Worked out once per run, so the warning shows
// once and every course of the run lands in the same place.
export function resolveDownloadsDir(): string {
    if (resolvedDownloadsDir) return resolvedDownloadsDir;
    const fallback = path.resolve(process.cwd(), 'downloads');
    let dir = fallback;
    const override = process.env.SKOOL_DOWNLOADS_DIR?.trim();
    if (override) {
        const wanted = path.resolve(override);
        const problem = downloadsDirProblem(wanted);
        if (problem) {
            console.warn(`⚠️  SKOOL_DOWNLOADS_DIR ${wanted} ${problem}. Using ${fallback} instead.`);
        } else {
            dir = wanted;
        }
    }
    resolvedDownloadsDir = dir;
    return dir;
}

// Only the last folder is created. Its parent must exist: creating the whole
// path under an unmounted mount point would write to the wrong disk.
function downloadsDirProblem(dir: string): string | null {
    try {
        if (!fs.existsSync(dir)) {
            const parent = path.dirname(dir);
            if (!fs.existsSync(parent)) return `is not available (${parent} does not exist)`;
            fs.mkdirSync(dir);
        }
        if (!fs.statSync(dir).isDirectory()) return 'is not a folder';
        fs.accessSync(dir, fs.constants.W_OK);
        return null;
    } catch (err) {
        return `is not available (${(err as NodeJS.ErrnoException).code ?? String(err)})`;
    }
}

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
