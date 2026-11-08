import path from 'path';
import fs from 'fs-extra';

/**
 * `<name>.tracks.json`, next to a video: what each audio track and subtitle
 * file is and where it came from. The lesson page's player reads it, and it
 * is what a later step that translates or re-subtitles lessons uses to tell
 * an automatic subtitle from one written by a person. A summary goes into
 * `lesson.json` as `media`.
 *
 * Subtitle `origin`:
 * - `manual`: uploaded by the video's author.
 * - `auto-asr`: YouTube's speech recognition of what is said.
 * - `auto-translated`: YouTube's machine translation of that, from
 *   `translatedFrom`.
 * - `auto`: automatic, but which of the two is unknown (a file saved before
 *   this manifest existed, recognised by YouTube's per-word timing tags).
 * - `unknown`: nothing says. Subtitles that came inside the video file
 *   (`extractedFrom: "embedded"`, e.g. Vimeo's) are this.
 * Any other value is left alone. A tool that improves a subtitle writes its
 * own file and entry with its origin (e.g. `improved`) and `generator`; for a
 * language with several, the player shows the one that is not automatic.
 *
 * Every subtitle this tool classifies also carries the origin in its `.vtt`,
 * as a `NOTE skool-downloader: …` block, so the file says it on its own.
 */

export type AudioTrackInfo = {
    lang: string;
    /** The file the browser player uses; absent for the video's own first track. */
    file?: string;
    kind?: 'original' | 'dubbed';
    /** `auto` for a dub YouTube generated. */
    generated?: 'auto';
    /** YouTube's own description of the track. */
    note?: string;
};

export type SubtitleTrackInfo = {
    lang: string;
    file: string;
    origin: string;
    translatedFrom?: string;
    generator?: string;
    /** `embedded`: taken out of the video file, which says nothing of who wrote it. */
    extractedFrom?: 'embedded';
};

export type TracksManifest = {
    source?: string;
    fetchedAt?: string;
    originalLanguage?: string;
    audio: AudioTrackInfo[];
    subtitles: SubtitleTrackInfo[];
};

/** What the video host says about the tracks, known only when downloading. */
export type TrackFacts = {
    source: string;
    originalLanguage?: string;
    audio: Array<Omit<AudioTrackInfo, 'file'>>;
    /** By the subtitle's key in its file name (`es`, `en-orig`). */
    subtitles: Record<string, { origin: string; translatedFrom?: string }>;
    generator: string;
};

export const tracksManifestName = (videoName: string) => `${videoName}.tracks.json`;
// Written for a few hours before tracks.json replaced it.
const legacyAudioManifestName = (videoName: string) => `${videoName}.audio.json`;

export const isAutomatic = (origin: string) => origin === 'auto' || origin.startsWith('auto-');

export const baseLanguage = (code: string) => code.replace(/-orig$/, '').split('-')[0]!.toLowerCase();

/**
 * The name (without `.mp4`) of a lesson folder's video: `video` when the
 * tool saved it, otherwise the only `.mp4` in the folder, since videos are
 * often downloaded by hand and keep their own names. Null when there is none,
 * or several and no way to tell which. Files elsewhere (`resources/`,
 * `posts/`, subfolders) do not count.
 */
export async function findLessonVideo(dir: string): Promise<string | null> {
    let entries: string[];
    try {
        entries = await fs.readdir(dir);
    } catch {
        return null;
    }
    if (entries.includes('video.mp4')) return 'video';
    // yt-dlp's leftovers of an unfinished download are not videos.
    const videos = entries.filter(name => /\.mp4$/i.test(name) && !/\.(temp|part)\.mp4$|\.f\d+\.mp4$/i.test(name));
    if (videos.length !== 1) return null;
    return videos[0]!.replace(/\.mp4$/i, '');
}

export async function readTracksManifest(dir: string, videoName: string): Promise<TracksManifest | null> {
    try {
        const manifest = await fs.readJson(path.join(dir, tracksManifestName(videoName)));
        if (!manifest || !Array.isArray(manifest.audio) || !Array.isArray(manifest.subtitles)) return null;
        return manifest as TracksManifest;
    } catch {
        return null;
    }
}

/**
 * The subtitle files next to a video, `<name>.<key>.vtt`, with an origin
 * guessed from their content: YouTube puts a `<00:00:01.230>` tag on every
 * word of its automatic captions and never on uploaded ones.
 */
export async function scanSubtitleFiles(dir: string, videoName: string): Promise<SubtitleTrackInfo[]> {
    let entries: string[];
    try {
        entries = await fs.readdir(dir);
    } catch {
        return [];
    }
    const prefix = `${videoName}.`;
    const found: SubtitleTrackInfo[] = [];
    for (const name of entries) {
        if (!name.startsWith(prefix) || !name.endsWith('.vtt')) continue;
        const key = name.slice(prefix.length, -'.vtt'.length);
        if (!/^[A-Za-z0-9-]{1,20}$/.test(key)) continue;
        let origin = 'unknown';
        try {
            const text = await fs.readFile(path.join(dir, name), 'utf8');
            const noted = /^NOTE skool-downloader:.*\borigin=([\w-]+)/m.exec(text);
            origin = noted ? noted[1]! : /<\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}><c>/.test(text) ? 'auto' : 'unknown';
        } catch {
            // Unreadable: listed, but as unknown.
        }
        found.push({ lang: key.replace(/-orig$/, ''), file: name, origin });
    }
    return found;
}

/** Adds or replaces the `NOTE skool-downloader:` block after the header. */
export function withOriginNote(vtt: string, track: SubtitleTrackInfo): string {
    const note = `NOTE skool-downloader: origin=${track.origin}` +
        (track.translatedFrom ? ` translatedFrom=${track.translatedFrom}` : '') +
        (track.generator ? ` generator=${track.generator}` : '') +
        (track.extractedFrom ? ` extractedFrom=${track.extractedFrom}` : '');
    const text = vtt.replace(/\r\n?/g, '\n');
    if (/^NOTE skool-downloader:.*$/m.test(text)) {
        return text.replace(/^NOTE skool-downloader:.*$/m, note);
    }
    const headerEnd = text.indexOf('\n\n');
    if (headerEnd === -1) return `${text.trimEnd()}\n\n${note}\n`;
    return `${text.slice(0, headerEnd)}\n\n${note}${text.slice(headerEnd)}`;
}

/**
 * Rewrites `<name>.tracks.json` from what is on disk. `audio` is the video's
 * audio streams in order (with the extra files); `facts` what the host said
 * on this download; `extracted` the subtitle files just taken out of the
 * video. Without facts, what an earlier manifest recorded is kept, and only
 * new files are guessed.
 */
export async function updateTracksManifest(
    dir: string,
    videoName: string,
    audio: Array<{ lang: string; file?: string }>,
    facts?: TrackFacts,
    extracted: string[] = []
): Promise<TracksManifest | null> {
    const previous = await readTracksManifest(dir, videoName);

    const audioTracks: AudioTrackInfo[] = audio.map(track => {
        const known = facts?.audio.find(a => baseLanguage(a.lang) === baseLanguage(track.lang))
            ?? previous?.audio.find(a => a.lang === track.lang);
        return {
            lang: track.lang,
            ...(track.file ? { file: track.file } : {}),
            ...(known?.kind ? { kind: known.kind } : {}),
            ...(known?.generated ? { generated: known.generated } : {}),
            ...(known?.note ? { note: known.note } : {})
        };
    });

    const subtitles: SubtitleTrackInfo[] = [];
    for (const scanned of await scanSubtitleFiles(dir, videoName)) {
        const key = scanned.file.slice(`${videoName}.`.length, -'.vtt'.length);
        const fact = facts?.subtitles[key];
        const old = previous?.subtitles.find(s => s.file === scanned.file);
        const fromVideo = extracted.includes(scanned.file);
        const track: SubtitleTrackInfo = fact
            ? { lang: scanned.lang, file: scanned.file, ...fact, generator: facts!.generator }
            : fromVideo
                ? { lang: scanned.lang, file: scanned.file, origin: 'unknown', extractedFrom: 'embedded' }
                : old ?? scanned;
        subtitles.push(track);

        // Only for what this tool classified: another tool's file and note
        // are its own.
        if (fact || fromVideo || (!old && track.origin !== 'unknown')) {
            const filePath = path.join(dir, scanned.file);
            const text = await fs.readFile(filePath, 'utf8');
            const updated = withOriginNote(text, track);
            if (updated !== text) await fs.writeFile(filePath, updated);
        }
    }
    // Entries for other files another tool added (e.g. .srt) stay while the
    // file does.
    for (const old of previous?.subtitles ?? []) {
        if (subtitles.some(s => s.file === old.file)) continue;
        if (await fs.pathExists(path.join(dir, old.file))) subtitles.push(old);
    }

    await fs.remove(path.join(dir, legacyAudioManifestName(videoName))).catch(() => {});
    if (audioTracks.length < 2 && subtitles.length === 0) return null;

    const manifest: TracksManifest = {
        ...(facts ? { source: facts.source, fetchedAt: new Date().toISOString() }
            : previous?.source ? { source: previous.source, fetchedAt: previous.fetchedAt } : {}),
        ...((facts?.originalLanguage ?? previous?.originalLanguage) ? { originalLanguage: facts?.originalLanguage ?? previous?.originalLanguage } : {}),
        audio: audioTracks,
        subtitles
    };
    await fs.writeJson(path.join(dir, tracksManifestName(videoName)), manifest, { spaces: 2 });
    return manifest;
}

/** The part of the manifest that goes into `lesson.json`. */
export function tracksSummary(manifest: TracksManifest | null) {
    if (!manifest) return undefined;
    return {
        ...(manifest.originalLanguage ? { originalLanguage: manifest.originalLanguage } : {}),
        audio: manifest.audio.map(({ lang, kind, generated }) => ({ lang, ...(kind ? { kind } : {}), ...(generated ? { generated } : {}) })),
        subtitles: manifest.subtitles.map(({ lang, file, origin, translatedFrom, extractedFrom }) => ({
            lang, file, origin, ...(translatedFrom ? { translatedFrom } : {}), ...(extractedFrom ? { extractedFrom } : {})
        }))
    };
}
