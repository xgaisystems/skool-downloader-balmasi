/**
 * YouTube videos can carry several audio tracks (the original plus dubs) and
 * subtitles in many languages. For these languages, in this order, the video
 * gets every audio track that exists and the subtitles, embedded in the mp4
 * and kept as `<name>.<lang>.vtt` next to it for the lesson page's player
 * (`src/video-player.ts`). The first audio track is the default one.
 * `SKOOL_YOUTUBE_LANGS=es,en` overrides it.
 */
export function youtubeLanguages(): string[] {
    const raw = process.env.SKOOL_YOUTUBE_LANGS?.trim();
    const langs = (raw ? raw.split(',') : ['es', 'en'])
        .map(l => l.trim().toLowerCase())
        .filter(l => /^[a-z]{2,3}$/.test(l));
    return langs.length > 0 ? [...new Set(langs)] : ['es', 'en'];
}

export function isYouTubeUrl(url: string): boolean {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }
    return host === 'youtu.be' ||
        host === 'youtube.com' || host.endsWith('.youtube.com') ||
        host === 'youtube-nocookie.com' || host.endsWith('.youtube-nocookie.com');
}

/** The part of `yt-dlp -J` this module reads. */
import { baseLanguage, type TrackFacts } from './media-tracks.js';

export type YouTubeInfo = {
    /** The language spoken in the original. */
    language?: string | null;
    formats?: Array<{
        vcodec?: string;
        acodec?: string;
        language?: string | null;
        /** Holds the audio track's name: "English (US) original (default)", "Spanish dubbed-auto". */
        format_note?: string | null;
        /** 10 for the original audio track. */
        language_preference?: number | null;
    }>;
    subtitles?: Record<string, unknown>;
    automatic_captions?: Record<string, unknown>;
};

export type YouTubePlan = {
    /** Languages that will be separate audio tracks, in track order. */
    audioLanguages: string[];
    /** yt-dlp subtitle keys, e.g. `es`, `en-US`. */
    subtitleKeys: string[];
    formatArgs: string[];
    subtitleArgs: string[];
    /** Arguments that fetch one subtitle on its own, without the video. */
    singleSubtitleArgs: (key: string) => string[];
    /** Where each track comes from, for `<name>.tracks.json`. */
    facts: Omit<TrackFacts, 'source'>;
};

const exactKey = (key: string) => `^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

const matchesLang = (code: string | null | undefined, lang: string) =>
    !!code && (code.toLowerCase() === lang || code.toLowerCase().startsWith(`${lang}-`));

/** A language's name in that language: `Español`, `English`. */
export function languageLabel(code: string): string {
    const base = code.replace(/-orig$/, '');
    try {
        const name = new Intl.DisplayNames([base], { type: 'language' }).of(base);
        if (name) return name.charAt(0).toUpperCase() + name.slice(1);
    } catch {
        // An unusual code: show it as is.
    }
    return base;
}

// MP4 stores a stream's language as an ISO 639-2 code; ffmpeg leaves a
// two-letter one as `und`.
export const ISO_639_2: Record<string, string> = {
    es: 'spa', en: 'eng', fr: 'fra', de: 'deu', it: 'ita', pt: 'por', ca: 'cat',
    nl: 'nld', pl: 'pol', ru: 'rus', tr: 'tur', ar: 'ara', hi: 'hin', ja: 'jpn',
    ko: 'kor', zh: 'zho', id: 'ind', vi: 'vie', th: 'tha', uk: 'ukr', sv: 'swe'
};

export function planYouTubeDownload(info: YouTubeInfo, langs: string[] = youtubeLanguages()): YouTubePlan {
    const audioFormats = (info.formats ?? []).filter(f => f.vcodec === 'none' && f.acodec && f.acodec !== 'none');
    const audioLanguages = langs.filter(lang => audioFormats.some(f => matchesLang(f.language, lang)));

    const autoKeys = Object.keys(info.automatic_captions ?? {});
    const originalLanguage = (info.language ? baseLanguage(info.language) : undefined)
        ?? autoKeys.find(k => k.endsWith('-orig'))?.replace(/-orig$/, '').split('-')[0];

    // With a single wanted track there is nothing to choose: yt-dlp's default
    // pick is the original audio. The fallbacks keep a video whose language
    // tags change between the probe and the download from failing.
    // YouTube tags every audio stream with the original's language and the
    // merger does not set it, so name each track here; the merger keeps the
    // order of the format selector. A `Merger:` value is added to the
    // `ffmpeg:` arguments, it does not replace them.
    // (A stream title would be dropped: the mp4 muxer does not store one.)
    const trackMetadata = audioLanguages.flatMap((lang, i) => {
        const iso = lang.length === 3 ? lang : ISO_639_2[lang];
        return iso ? [`-metadata:s:a:${i} language=${iso}`] : [];
    });
    const formatArgs = audioLanguages.length >= 2
        ? [
            '--audio-multistreams',
            '-f', `bv*${audioLanguages.map(l => `+ba[language^=${l}]`).join('')}/bv*+ba/b`,
            ...(trackMetadata.length > 0 ? ['--postprocessor-args', `Merger:${trackMetadata.join(' ')}`] : [])
        ]
        : [];

    // Uploaded subtitles first; YouTube's automatic ones (the speech
    // recognition of the original, or a machine translation of it) only for
    // a language without them.
    const manual = Object.keys(info.subtitles ?? {}).filter(k => k !== 'live_chat');
    const auto = autoKeys;
    const subtitleKeys: string[] = [];
    const subtitleOrigins: TrackFacts['subtitles'] = {};
    let needsAuto = false;
    for (const lang of langs) {
        const key = manual.find(k => k.toLowerCase() === lang) ?? manual.find(k => matchesLang(k, lang));
        if (key) {
            subtitleKeys.push(key);
            subtitleOrigins[key] = { origin: 'manual' };
            continue;
        }
        const autoKey = [lang, `${lang}-orig`].find(k => auto.includes(k));
        if (autoKey) {
            subtitleKeys.push(autoKey);
            needsAuto = true;
            subtitleOrigins[autoKey] = autoKey.endsWith('-orig') || lang === originalLanguage || !originalLanguage
                ? { origin: originalLanguage ? 'auto-asr' : 'auto' }
                : { origin: 'auto-translated', translatedFrom: originalLanguage };
        }
    }

    const subtitleArgs = subtitleKeys.length > 0
        ? [
            '--write-subs',
            ...(needsAuto ? ['--write-auto-subs'] : []),
            // Exact keys: a pattern such as `en.*` also takes every machine
            // translation (`en-de`...), and each one is a request.
            '--sub-langs', subtitleKeys.map(exactKey).join(','),
            '--sub-format', 'vtt/best',
            '--convert-subs', 'vtt',
            '--embed-subs'
        ]
        : [];

    const singleSubtitleArgs = (key: string) => [
        '--skip-download',
        '--write-subs',
        ...(needsAuto ? ['--write-auto-subs'] : []),
        '--sub-langs', exactKey(key),
        '--sub-format', 'vtt/best',
        '--convert-subs', 'vtt'
    ];

    // The note of an audio-only format names its track; the m3u8 ones say
    // "dubbed" without "auto", so prefer a note that says more.
    const audioFacts = [...new Set([...audioLanguages, ...(originalLanguage ? [originalLanguage] : [])])].map(lang => {
        const notes = audioFormats.filter(f => matchesLang(f.language, lang));
        const original = notes.some(f => (f.language_preference ?? 0) >= 10 || /\boriginal\b/i.test(f.format_note ?? ''));
        const note = notes.map(f => f.format_note ?? '').find(n => /dubbed-auto|original/i.test(n)) ?? notes[0]?.format_note ?? undefined;
        const dubbed = !original && (notes.some(f => /dubbed/i.test(f.format_note ?? '')) || !!originalLanguage && lang !== originalLanguage);
        const autoDub = notes.some(f => /dubbed-auto|auto-dub/i.test(f.format_note ?? ''));
        return {
            lang,
            ...(original ? { kind: 'original' as const } : dubbed ? { kind: 'dubbed' as const } : {}),
            ...(autoDub ? { generated: 'auto' as const } : {}),
            ...(note ? { note: note.replace(/,\s*(low|medium|high|ultralow)\b.*$/i, '').trim() } : {})
        };
    });

    return {
        audioLanguages,
        subtitleKeys,
        formatArgs,
        subtitleArgs,
        singleSubtitleArgs,
        facts: {
            ...(originalLanguage ? { originalLanguage } : {}),
            audio: audioFacts,
            subtitles: subtitleOrigins,
            generator: 'youtube'
        }
    };
}

/**
 * yt-dlp reports a subtitle that could not be fetched (YouTube answers 429 to
 * bursts of automatic translations) as an error of the whole video.
 */
export function isSubtitleFailure(error: unknown): boolean {
    return /Unable to download video subtitles/i.test(String(error));
}

/**
 * yt-dlp needs a JavaScript runtime to solve YouTube's challenges, and only
 * looks for deno by default. Without one it falls back to clients with fewer
 * formats, which may have no dubbed audio at all. Node is always there: it is
 * running this.
 */
export function youtubeRuntimeArgs(): string[] {
    return ['--js-runtimes', `node:${process.execPath}`];
}
