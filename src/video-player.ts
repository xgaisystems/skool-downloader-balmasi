import path from 'path';
import fs from 'fs-extra';
import { languageLabel, youtubeLanguages } from './youtube.js';
import { escapeHtml } from './utils.js';
import { isAutomatic, readTracksManifest, scanSubtitleFiles, type AudioTrackInfo, type SubtitleTrackInfo } from './media-tracks.js';

/**
 * The lesson page's video player.
 *
 * A plain `<video controls>` cannot offer what a YouTube video saved with
 * several audio tracks and subtitles has: Chrome and Firefox play only the
 * first audio track of an mp4 and have no way to pick another, and Chrome
 * refuses `<track>` files on a `file://` page. So when there is more than one
 * audio track or any subtitle, the page gets its own controls:
 *
 * Playback controls sit over the picture; the language choice is a panel of
 * buttons under it, which stays in fullscreen.
 *
 * - Audio: the video element plays its first track. Each other track is
 *   saved as `<name>.<lang>.m4a` (`Downloader.prepareTracks()`, listed in
 *   `<name>.tracks.json`); choosing one mutes the video and plays that file in
 *   an `<audio>` kept in step with it.
 * - Subtitles: the `.vtt` files next to the video are parsed here and the
 *   cues embedded in the page, which draws them itself, so they work on
 *   `file://`, in fullscreen and with any track.
 *
 * Automatic subtitles and dubbed audio are labelled as such (`· AUTO`,
 * `· doblaje`, with the detail in a tooltip and in `data-origin` /
 * `data-kind`), and a note under the buttons says so while an automatic
 * subtitle is on; `src/media-tracks.ts` says where that comes from.
 *
 * Without either, or without JavaScript, it is the plain `<video controls>`.
 * Everything from the files reaches the page as JSON inside a script element
 * with `<` escaped, and is shown with `textContent`: these pages share an
 * origin with the local progress API.
 */

type Cue = [number, number, string];

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };

function parseTimestamp(value: string): number | null {
    const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(value.trim());
    if (!m) return null;
    return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, '0')) / 1000;
}

function cleanLine(line: string): string {
    return line
        .replace(/<[^>]*>/g, '')
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
            if (name[0] === '#') {
                const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
                return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
            }
            return ENTITIES[name.toLowerCase()] ?? whole;
        })
        .replace(/[​‌‍﻿]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Readable subtitles: what YouTube's own player shows for automatic captions.
const MAX_CUE_CHARS = 84;
const LINE_CHARS = 42;
const PAUSE_BREAK_S = 2;
const LINGER_S = 2.5;
const WORD_TIMESTAMP = /<(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})>/;

type VttBlock = { start: number; end: number; lines: string[] };

function vttBlocks(text: string): VttBlock[] {
    const blocks: VttBlock[] = [];
    for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
        const lines = block.split('\n');
        const timingIndex = lines.findIndex(l => l.includes('-->'));
        if (timingIndex === -1) continue;
        const [startRaw, rest] = lines[timingIndex]!.split('-->');
        const start = parseTimestamp(startRaw ?? '');
        const end = parseTimestamp((rest ?? '').trim().split(/\s+/)[0] ?? '');
        if (start === null || end === null) continue;
        blocks.push({ start, end, lines: lines.slice(timingIndex + 1) });
    }
    return blocks;
}

/** Splits at the space nearest the middle, as YouTube's two-line captions. */
function balanceLines(text: string): string {
    if (text.length <= LINE_CHARS) return text;
    const middle = text.length / 2;
    let best = -1;
    for (let i = text.indexOf(' '); i !== -1; i = text.indexOf(' ', i + 1)) {
        if (best === -1 || Math.abs(i - middle) < Math.abs(best - middle)) best = i;
    }
    return best === -1 ? text : `${text.slice(0, best)}\n${text.slice(best + 1)}`;
}

/**
 * YouTube's automatic captions (and their machine translations) come as
 * cues of a second or so holding two to six words, each repeated as the
 * first line of the next cue, with every word's time in a `<00:00:01.230>`
 * tag. Shown as they are they flash past. The new line of each cue gives
 * the words in order with their times; those are regrouped into cues of up
 * to two balanced lines, cut at the end of a sentence or at a pause, each
 * kept on screen until the next one starts.
 */
function regroupWordTimedCaptions(blocks: VttBlock[]): Cue[] {
    const words: Array<{ t: number; w: string }> = [];
    let previousLine = '';
    for (const block of blocks) {
        if (block.end - block.start < 0.05) continue;
        const raw = [...block.lines].reverse().find(l => cleanLine(l));
        if (!raw) continue;
        const plain = cleanLine(raw);
        if (plain === previousLine) continue;
        previousLine = plain;

        // ['text', '00:00:01.230', 'text', ...]: a word's time is the last
        // tag before it, or the cue's start.
        let time = block.start;
        raw.split(WORD_TIMESTAMP).forEach((part, i) => {
            if (i % 2 === 1) {
                time = parseTimestamp(part) ?? time;
                return;
            }
            for (const w of cleanLine(part).split(' ').filter(Boolean)) words.push({ t: time, w });
        });
    }

    const cues: Cue[] = [];
    let current: typeof words = [];
    const flush = (nextStart: number | null) => {
        if (current.length === 0) return;
        const start = current[0]!.t;
        const lastWord = current[current.length - 1]!.t;
        let end = Math.min(nextStart ?? Infinity, lastWord + LINGER_S);
        if (end - start < 1) end = nextStart === null ? start + 1 : Math.max(Math.min(start + 1, nextStart), end);
        cues.push([start, end, balanceLines(current.map(x => x.w).join(' '))]);
        current = [];
    };
    for (const word of words) {
        const previous = current[current.length - 1];
        if (previous) {
            const text = current.map(x => x.w).join(' ');
            const sentenceEnded = /[.?!…]["')\]]?$/.test(previous.w) && text.length >= 25;
            if (text.length + 1 + word.w.length > MAX_CUE_CHARS || word.t - previous.t > PAUSE_BREAK_S || sentenceEnded) {
                flush(word.t);
            }
        }
        current.push(word);
    }
    flush(null);
    return cues;
}

/**
 * WebVTT to `[start, end, text]`, without styling tags and repeated cues.
 * YouTube's automatic captions are regrouped into readable lines
 * (`regroupWordTimedCaptions()`); other subtitles keep their own timing.
 */
export function parseVtt(text: string): Cue[] {
    const blocks = vttBlocks(text);
    const cues = blocks.some(b => b.lines.some(l => WORD_TIMESTAMP.test(l)))
        ? regroupWordTimedCaptions(blocks)
        : plainCues(blocks);
    return cues
        .sort((a, b) => a[0] - b[0])
        .map(([s, e, t]) => [Math.round(s * 100) / 100, Math.round(e * 100) / 100, t]);
}

/** Cues as they come, minus YouTube's 10 ms filler cues and repeats. */
function plainCues(blocks: VttBlock[]): Cue[] {
    const cues: Cue[] = [];
    for (const { start, end, lines } of blocks) {
        if (end - start < 0.05) continue;
        const body = lines.map(cleanLine).filter(Boolean).join('\n');
        if (!body) continue;

        const last = cues[cues.length - 1];
        if (last && last[2] === body && start - last[1] < 0.05) {
            last[1] = Math.max(last[1], end);
            continue;
        }
        cues.push([start, end, body]);
    }
    return cues;
}

type PlayerAudio = { lang: string; label: string; src?: string; info: AudioTrackInfo };
type PlayerSubtitle = { lang: string; label: string; auto: boolean; cues: Cue[]; info: SubtitleTrackInfo };

// Only a file next to the video, by name: never a path or a URL.
const isLocalFile = (file: unknown): file is string =>
    typeof file === 'string' && file.length > 0 && file === path.basename(file) && !file.startsWith('.');

async function readTracks(dir: string, videoName: string): Promise<{ audio: PlayerAudio[]; subtitles: PlayerSubtitle[] }> {
    const manifest = await readTracksManifest(dir, videoName);

    const audio: PlayerAudio[] = [];
    for (const [i, info] of (manifest?.audio ?? []).entries()) {
        if (typeof info?.lang !== 'string') continue;
        if (i > 0 && !(isLocalFile(info.file) && await fs.pathExists(path.join(dir, info.file)))) continue;
        audio.push({ lang: info.lang, label: languageLabel(info.lang), ...(i > 0 ? { src: info.file } : {}), info });
    }

    // A language may have an automatic subtitle and a better one added later:
    // the one that is not automatic wins.
    const langs = youtubeLanguages();
    const rank = (code: string) => {
        const i = langs.findIndex(l => code === l || code.startsWith(`${l}-`));
        return i === -1 ? langs.length : i;
    };
    const candidates = (manifest?.subtitles ?? await scanSubtitleFiles(dir, videoName))
        .filter(t => typeof t?.lang === 'string' && isLocalFile(t.file) && t.file.endsWith('.vtt'))
        .sort((a, b) => rank(a.lang) - rank(b.lang) || a.lang.localeCompare(b.lang)
            || Number(isAutomatic(a.origin)) - Number(isAutomatic(b.origin)));

    const subtitles: PlayerSubtitle[] = [];
    for (const info of candidates) {
        if (subtitles.some(s => s.lang === info.lang)) continue;
        try {
            const cues = parseVtt(await fs.readFile(path.join(dir, info.file), 'utf8'));
            if (cues.length > 0) {
                const label = info.lang === 'und' ? 'Subtítulos' : languageLabel(info.lang);
                subtitles.push({ lang: info.lang, label, auto: isAutomatic(info.origin ?? ''), cues, info });
            }
        } catch {
            // An unreadable file only loses that language.
        }
    }
    return { audio: audio.length > 1 ? audio : [], subtitles };
}

function languageNameInSpanish(code: string): string {
    try {
        return new Intl.DisplayNames(['es'], { type: 'language' }).of(code) ?? code;
    } catch {
        return code;
    }
}

function subtitleTooltip(info: SubtitleTrackInfo): string {
    if (info.origin === 'unknown' && info.extractedFrom === 'embedded') {
        return 'Subtítulos incluidos en el archivo de vídeo; no se sabe si son automáticos.';
    }
    switch (info.origin) {
        case 'manual': return 'Subtítulos subidos por el autor del vídeo.';
        case 'auto-asr': return 'Transcripción automática de YouTube. Puede contener errores.';
        case 'auto-translated':
            return info.translatedFrom
                ? `Traducción automática de YouTube del ${languageNameInSpanish(info.translatedFrom)}. Puede contener errores.`
                : 'Traducción automática de YouTube. Puede contener errores.';
        case 'auto': return 'Generados automáticamente por YouTube. Pueden contener errores.';
        case 'unknown': return '';
        default: return `Origen: ${info.origin}${info.generator ? ` (${info.generator})` : ''}.`;
    }
}

function audioTooltip(info: AudioTrackInfo): string {
    if (info.kind === 'original') return 'Audio original.';
    if (info.kind === 'dubbed') return info.generated === 'auto' ? 'Doblaje generado automáticamente por YouTube.' : 'Doblaje.';
    return '';
}

// Around the player in a lesson page, so `regenerateIndex()` can swap it for
// one built from the files on disk now (e.g. after better subtitles were
// added), without visiting Skool.
const PLAYER_START = '<!-- skool-video-player -->';
const PLAYER_END = '<!-- /skool-video-player -->';

/**
 * The page with its video player replaced by `player`, or null when no
 * player is found. Recognises the marked player, the unmarked player of the
 * first version, and a plain `<video>` element playing `videoFile` (older
 * pages, or one added by hand), under that name either as is or URL-encoded.
 */
export function replaceVideoPlayer(html: string, player: string, videoFile = 'video.mp4'): string | null {
    const marked = new RegExp(`${PLAYER_START}[\\s\\S]*?${PLAYER_END}`);
    const unmarked = /<div class="vp" tabindex="0"[\s\S]*?var PREFS_KEY = 'skool-player-prefs'[\s\S]*?<\/script>/;
    const names = [...new Set([videoFile, encodeURI(videoFile), encodeURIComponent(videoFile), escapeHtml(videoFile)])]
        .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const plain = new RegExp(`<video\\b[^>]*\\bsrc="(?:\\./)?(?:${names.join('|')})"[^>]*>[\\s\\S]*?<\\/video>`);
    for (const pattern of [marked, unmarked, plain]) {
        if (pattern.test(html)) return html.replace(pattern, () => player);
    }
    return null;
}

const scriptJson = (value: unknown) =>
    JSON.stringify(value).replace(/</g, '\\u003c');

export async function renderVideoPlayer(dir: string, videoName = 'video'): Promise<string> {
    const src = encodeURIComponent(`${videoName}.mp4`);
    const { audio, subtitles } = await readTracks(dir, videoName);
    if (audio.length === 0 && subtitles.length === 0) {
        return `${PLAYER_START}<video controls src="${src}"></video>${PLAYER_END}`;
    }

    const button = (attr: string, value: number, label: string, active: boolean, extra: Record<string, string> = {}) =>
        `<button type="button" class="vp-track${active ? ' active' : ''}" ${attr}="${value}" aria-pressed="${active}"` +
        Object.entries(extra).filter(([, v]) => v).map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join('') +
        `>${escapeHtml(label)}</button>`;
    const audioButtons = audio.map((t, i) => button('data-vp-audio', i,
        `${flagOf(t.lang)}${t.label}${i === 0 ? ' (Predeterminado)' : ''}${t.info.kind === 'dubbed' ? ' · doblaje' : ''}`,
        i === 0,
        { 'data-kind': t.info.kind ?? '', 'data-generated': t.info.generated ?? '', title: audioTooltip(t.info) }));
    const subtitleButtons = [
        button('data-vp-cc', -1, 'Desactivados', true),
        ...subtitles.map((t, i) => button('data-vp-cc', i,
            `${flagOf(t.lang)}${t.label}${t.auto ? ' · AUTO' : ''}`,
            false,
            { 'data-origin': t.info.origin ?? '', 'data-translated-from': t.info.translatedFrom ?? '', title: subtitleTooltip(t.info) }))
    ];

    return `${PLAYER_START}
<div class="vp" tabindex="0" aria-label="Reproductor de vídeo">
    <div class="vp-stage">
    <div class="vp-screen">
        <video controls preload="metadata" playsinline src="${src}"></video>
        <div class="vp-subs" aria-hidden="true"></div>
        <button type="button" class="vp-big" aria-label="Reproducir">${ICONS.play}</button>
    </div>
    <div class="vp-bar">
        <button type="button" class="vp-btn vp-play" aria-label="Reproducir">${ICONS.play}</button>
        <span class="vp-time">0:00 / 0:00</span>
        <input class="vp-seek" type="range" min="0" max="1000" step="1" value="0" aria-label="Posición">
        <button type="button" class="vp-btn vp-mute" aria-label="Silenciar">${ICONS.volume}</button>
        <input class="vp-volume" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volumen">
        <select class="vp-rate" aria-label="Velocidad">
            ${[0.75, 1, 1.25, 1.5, 1.75, 2].map(r => `<option value="${r}"${r === 1 ? ' selected' : ''}>${r}×</option>`).join('')}
        </select>
        <button type="button" class="vp-btn vp-fs" aria-label="Pantalla completa">${ICONS.fullscreen}</button>
    </div>
    </div>
    <div class="vp-langs">
        ${audioButtons.length > 1 ? `<div class="vp-group" role="group" aria-label="Audio"><span class="vp-group-title">🔊 Audio:</span><div class="vp-tracks">${audioButtons.join('')}</div></div>` : ''}
        ${subtitles.length > 0 ? `<div class="vp-group" role="group" aria-label="Subtítulos"><span class="vp-group-title">💬 Subtítulos:</span><div class="vp-tracks">${subtitleButtons.join('')}</div></div>` : ''}
        <p class="vp-notice" hidden>⚠️ Subtítulos generados automáticamente: pueden no ser fieles a lo que se dice.</p>
    </div>
    <script type="application/json" class="vp-data">${scriptJson({
        audio: audio.map(({ lang, label, src }) => ({ lang, label, ...(src ? { src: encodeURIComponent(src) } : {}) })),
        subtitles: subtitles.map(({ lang, label, auto, cues }) => ({ lang, label, auto, cues }))
    })}</script>
</div>
<style>${PLAYER_CSS}</style>
<script>${PLAYER_JS}</script>
${PLAYER_END}`;
}

const FLAGS: Record<string, string> = { es: '🇪🇸', en: '🇬🇧', fr: '🇫🇷', de: '🇩🇪', it: '🇮🇹', pt: '🇵🇹', ca: '', nl: '🇳🇱', ja: '🇯🇵', zh: '🇨🇳', ko: '🇰🇷', ru: '🇷🇺' };
const flagOf = (lang: string) => {
    const flag = FLAGS[lang.split('-')[0]!.toLowerCase()];
    return flag ? `${flag} ` : '';
};

const ICONS = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" fill="currentColor"/></svg>',
    volume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 5V4L8 9H4zm12.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z" fill="currentColor"/></svg>',
    muted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 5V4L8 9H4zm12.6 3 2.7-2.7-1.1-1.1-2.7 2.7-2.7-2.7-1.1 1.1 2.7 2.7-2.7 2.7 1.1 1.1 2.7-2.7 2.7 2.7 1.1-1.1z" fill="currentColor"/></svg>',
    fullscreen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h5v2H7v3H5zm9 0h5v5h-2V7h-3zM5 14h2v3h3v2H5zm12 0h2v5h-5v-2h3z" fill="currentColor"/></svg>'
};

const PLAYER_CSS = `
.vp { position: relative; margin: 10px 0 26px; border-radius: 14px; overflow: hidden; background: #000; box-shadow: 0 10px 24px rgba(15, 23, 42, 0.2); outline: none; }
.vp:focus-visible { box-shadow: 0 0 0 3px var(--accent, #3b82f6); }
.vp-stage, .vp-screen { position: relative; }
.vp video { margin: 0; border-radius: 0; box-shadow: none; width: 100%; display: block; max-height: 80vh; aspect-ratio: auto 16 / 9; }
.vp:fullscreen { border-radius: 0; display: flex; flex-direction: column; justify-content: center; }
.vp:fullscreen .vp-stage { flex: 1; min-height: 0; display: flex; }
.vp:fullscreen .vp-screen { flex: 1; min-height: 0; display: flex; align-items: center; }
.vp:fullscreen video { max-height: 100%; height: 100%; }
.vp-subs { position: absolute; left: 4%; right: 4%; bottom: 62px; text-align: center; pointer-events: none; transition: bottom .2s; }
.vp-subs span { display: inline; background: rgba(0, 0, 0, 0.78); color: #fff; padding: .1em .45em; border-radius: 4px; font-size: clamp(14px, 2.3vw, 30px); line-height: 1.45; white-space: pre-line; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.vp-big { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 72px; height: 72px; border-radius: 50%; border: 0; background: rgba(0, 0, 0, 0.6); color: #fff; cursor: pointer; display: none; padding: 18px; }
.vp-big svg { width: 100%; height: 100%; }
.vp.vp-ready.vp-paused .vp-big { display: block; }
.vp-bar { position: absolute; left: 0; right: 0; bottom: 0; display: none; align-items: center; gap: 8px; padding: 18px 10px 8px; background: linear-gradient(transparent, rgba(0, 0, 0, 0.85)); color: #fff; font: 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; transition: opacity .2s; }
.vp.vp-ready .vp-bar { display: flex; }
.vp.vp-idle .vp-bar { opacity: 0; pointer-events: none; }
.vp.vp-idle .vp-subs { bottom: 18px; }
.vp.vp-idle { cursor: none; }
.vp-btn { background: none; border: 0; color: inherit; width: 32px; height: 32px; padding: 4px; cursor: pointer; border-radius: 6px; flex: none; }
.vp-btn:hover, .vp-btn:focus-visible { background: rgba(255, 255, 255, 0.15); }
.vp-btn svg { width: 100%; height: 100%; display: block; }
.vp-time { font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }
.vp-seek { flex: 1 1 120px; min-width: 80px; accent-color: var(--accent, #3b82f6); cursor: pointer; }
.vp-volume { width: 70px; flex: none; accent-color: var(--accent, #3b82f6); cursor: pointer; }
.vp select { background: rgba(255, 255, 255, 0.12); color: #fff; border: 1px solid rgba(255, 255, 255, 0.28); border-radius: 6px; padding: 4px 6px; font: inherit; cursor: pointer; flex: none; }
.vp select option { color: #111; background: #fff; }
.vp-langs { background: #1e293b; padding: 12px 18px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid rgba(255, 255, 255, 0.08); font: 13px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; }
.vp-group { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.vp-group-title { font-size: 0.85rem; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
.vp-tracks { display: inline-flex; flex-wrap: wrap; background: rgba(15, 23, 42, 0.6); padding: 3px; border-radius: 8px; border: 1px solid rgba(255, 255, 255, 0.08); gap: 2px; }
.vp-track { background: transparent; border: 0; color: #cbd5e1; padding: 6px 12px; border-radius: 6px; font: 600 0.82rem/1.2 inherit; font-family: inherit; cursor: pointer; transition: background .2s, color .2s; }
.vp-track:hover { color: #fff; background: rgba(255, 255, 255, 0.08); }
.vp-track.active { background: var(--accent, #3b82f6); color: #fff; box-shadow: 0 2px 8px rgba(59, 130, 246, 0.4); }
.vp-track:focus-visible { outline: 2px solid #fff; outline-offset: 1px; }
.vp-notice { flex-basis: 100%; margin: 0; color: #fbbf24; font-size: 0.82rem; }
.vp-notice[hidden] { display: none; }
/* Narrow screens: the controls take three rows, so they go under the
   picture instead of over it. */
@media (max-width: 640px) {
    .vp-bar { position: static; flex-wrap: wrap; row-gap: 4px; padding: 6px 8px 8px; background: #111; }
    .vp.vp-idle .vp-bar { opacity: 1; pointer-events: auto; }
    .vp.vp-idle { cursor: auto; }
    .vp-seek { order: -1; flex-basis: 100%; }
    .vp-volume { display: none; }
    .vp-subs, .vp.vp-idle .vp-subs { bottom: 8px; }
    .vp-subs span { font-size: 14px; }
    .vp-langs { padding: 10px 12px; }
}
`;

// Runs once per player on the page. The icons are its only interpolation;
// it holds no backticks.
const PLAYER_JS = `
(function () {
    var PREFS_KEY = 'skool-player-prefs';
    function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch (e) { return {}; } }
    function savePrefs(patch) {
        try {
            var prefs = loadPrefs();
            for (var k in patch) prefs[k] = patch[k];
            localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
        } catch (e) {}
    }
    function fmt(t) {
        if (!isFinite(t) || t < 0) t = 0;
        var s = Math.floor(t % 60), m = Math.floor(t / 60) % 60, h = Math.floor(t / 3600);
        return (h ? h + ':' + (m < 10 ? '0' : '') : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }
    var ICON = ${JSON.stringify(ICONS)};

    document.querySelectorAll('.vp:not([data-vp-init])').forEach(function (root) {
        root.setAttribute('data-vp-init', '');
        var data;
        try { data = JSON.parse(root.querySelector('.vp-data').textContent); } catch (e) { return; }
        var video = root.querySelector('video');
        var subsBox = root.querySelector('.vp-subs');
        var big = root.querySelector('.vp-big');
        var playBtn = root.querySelector('.vp-play');
        var time = root.querySelector('.vp-time');
        var seek = root.querySelector('.vp-seek');
        var muteBtn = root.querySelector('.vp-mute');
        var volume = root.querySelector('.vp-volume');
        var rate = root.querySelector('.vp-rate');
        var audioBtns = root.querySelectorAll('[data-vp-audio]');
        var ccBtns = root.querySelectorAll('[data-vp-cc]');
        var notice = root.querySelector('.vp-notice');
        function markActive(buttons, attr, value) {
            buttons.forEach(function (b) {
                var on = Number(b.getAttribute(attr)) === value;
                b.classList.toggle('active', on);
                b.setAttribute('aria-pressed', String(on));
            });
        }
        var fsBtn = root.querySelector('.vp-fs');
        var prefs = loadPrefs();

        video.controls = false;
        root.classList.add('vp-ready', 'vp-paused');

        // ---- audio tracks ----
        var tracks = data.audio || [];
        var ext = new Audio();
        ext.preload = 'auto';
        var current = 0;
        var muted = false;

        function applyVolume() {
            var v = Number(volume.value);
            video.volume = v; ext.volume = v;
            video.muted = muted || current > 0;
            ext.muted = muted;
            muteBtn.innerHTML = muted || v === 0 ? ICON.muted : ICON.volume;
            muteBtn.setAttribute('aria-label', muted ? 'Activar sonido' : 'Silenciar');
        }
        // A seek leaves the audio a few hundred ms behind, since it starts
        // later than the video. Jumping again would only repeat that, so a
        // small gap is closed by playing the audio slightly faster or slower
        // (the browser keeps the pitch); only a large one is a seek.
        function syncExt(force) {
            if (current === 0) return;
            var diff = ext.currentTime - video.currentTime;
            if (force || Math.abs(diff) > 1) {
                try { ext.currentTime = video.currentTime; } catch (e) {}
                ext.playbackRate = video.playbackRate;
                return;
            }
            var adjust = Math.abs(diff) < 0.03 ? 0 : Math.max(-0.08, Math.min(0.08, -diff));
            var wanted = video.playbackRate * (1 + adjust);
            if (Math.abs(ext.playbackRate - wanted) > 0.005) ext.playbackRate = wanted;
        }
        function setAudio(i) {
            current = i;
            markActive(audioBtns, 'data-vp-audio', i);
            if (i === 0) {
                ext.pause();
                ext.removeAttribute('src');
                ext.load();
            } else {
                ext.src = tracks[i].src;
                ext.playbackRate = video.playbackRate;
                syncExt(true);
                if (!video.paused) ext.play().catch(function () {});
            }
            applyVolume();
        }
        ext.addEventListener('loadedmetadata', function () { syncExt(true); });
        if (tracks.length > 1) {
            audioBtns.forEach(function (b) {
                b.addEventListener('click', function () {
                    var i = Number(b.getAttribute('data-vp-audio'));
                    if (i === current) return;
                    setAudio(i);
                    savePrefs({ audio: tracks[i].lang });
                });
            });
            var wanted = tracks.findIndex(function (t) { return t.lang === prefs.audio; });
            if (wanted > 0) setAudio(wanted);
        }

        // ---- subtitles ----
        var subs = data.subtitles || [];
        var cues = null;
        var currentSub = -1;
        var shown = null;
        function renderSubs() {
            var text = '';
            if (cues) {
                var t = video.currentTime, lo = 0, hi = cues.length - 1, idx = -1;
                while (lo <= hi) {
                    var mid = (lo + hi) >> 1;
                    if (cues[mid][0] <= t) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
                }
                for (var j = idx; j >= 0 && j > idx - 4; j--) {
                    if (cues[j][1] > t) { text = cues[j][2]; break; }
                }
            }
            if (text === shown) return;
            shown = text;
            subsBox.textContent = '';
            if (text) {
                var span = document.createElement('span');
                span.textContent = text;
                subsBox.appendChild(span);
            }
        }
        function setSubs(i) {
            if (!(i >= 0 && subs[i])) i = -1;
            cues = i >= 0 ? subs[i].cues : null;
            currentSub = i;
            markActive(ccBtns, 'data-vp-cc', i);
            if (notice) notice.hidden = !(i >= 0 && subs[i].auto);
            renderSubs();
        }
        if (subs.length > 0) {
            ccBtns.forEach(function (b) {
                b.addEventListener('click', function () {
                    setSubs(Number(b.getAttribute('data-vp-cc')));
                    savePrefs({ subs: currentSub >= 0 ? subs[currentSub].lang : '' });
                });
            });
            setSubs(subs.findIndex(function (s) { return s.lang === prefs.subs; }));
        }

        // ---- playback ----
        function togglePlay() {
            if (video.paused || video.ended) video.play().catch(function () {}); else video.pause();
        }
        function updateTime() {
            var d = video.duration;
            time.textContent = fmt(video.currentTime) + ' / ' + fmt(d);
            if (!seeking && isFinite(d) && d > 0) seek.value = String(Math.round(video.currentTime / d * 1000));
        }
        var seeking = false;
        var frame = 0;
        function tick() {
            renderSubs();
            syncExt(false);
            frame = video.paused ? 0 : requestAnimationFrame(tick);
        }
        video.addEventListener('play', function () {
            root.classList.remove('vp-paused');
            playBtn.innerHTML = ICON.pause;
            playBtn.setAttribute('aria-label', 'Pausa');
            if (current > 0) { syncExt(true); ext.play().catch(function () {}); }
            if (!frame) frame = requestAnimationFrame(tick);
            armIdle();
        });
        video.addEventListener('pause', function () {
            root.classList.add('vp-paused');
            root.classList.remove('vp-idle');
            playBtn.innerHTML = ICON.play;
            playBtn.setAttribute('aria-label', 'Reproducir');
            ext.pause();
        });
        video.addEventListener('waiting', function () { ext.pause(); });
        video.addEventListener('playing', function () {
            if (current > 0) { syncExt(true); ext.play().catch(function () {}); }
        });
        video.addEventListener('seeked', function () { syncExt(true); renderSubs(); });
        video.addEventListener('ratechange', function () { ext.playbackRate = video.playbackRate; });
        // Also here: requestAnimationFrame stops in a background tab, and
        // the audio keeps playing there.
        video.addEventListener('timeupdate', function () { updateTime(); syncExt(false); });
        video.addEventListener('loadedmetadata', updateTime);
        video.addEventListener('durationchange', updateTime);
        video.addEventListener('click', togglePlay);
        video.addEventListener('dblclick', toggleFullscreen);
        big.addEventListener('click', togglePlay);
        playBtn.addEventListener('click', togglePlay);

        seek.addEventListener('input', function () {
            seeking = true;
            var d = video.duration;
            if (isFinite(d)) {
                video.currentTime = Number(seek.value) / 1000 * d;
                time.textContent = fmt(video.currentTime) + ' / ' + fmt(d);
            }
        });
        seek.addEventListener('change', function () { seeking = false; });

        if (typeof prefs.volume === 'number') volume.value = String(prefs.volume);
        volume.addEventListener('input', function () {
            muted = false;
            applyVolume();
            savePrefs({ volume: Number(volume.value) });
        });
        muteBtn.addEventListener('click', function () { muted = !muted; applyVolume(); });
        applyVolume();

        if (prefs.rate && rate.querySelector('option[value="' + Number(prefs.rate) + '"]')) rate.value = String(Number(prefs.rate));
        video.playbackRate = Number(rate.value);
        rate.addEventListener('change', function () {
            video.playbackRate = Number(rate.value);
            savePrefs({ rate: Number(rate.value) });
        });

        // ---- fullscreen, idle controls, keys ----
        function toggleFullscreen() {
            var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
            if (fsEl) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
            var req = root.requestFullscreen || root.webkitRequestFullscreen;
            if (req) req.call(root); else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
        }
        fsBtn.addEventListener('click', toggleFullscreen);

        var idleTimer = 0;
        function armIdle() {
            root.classList.remove('vp-idle');
            clearTimeout(idleTimer);
            idleTimer = setTimeout(function () { if (!video.paused) root.classList.add('vp-idle'); }, 2500);
        }
        root.addEventListener('mousemove', armIdle);
        root.addEventListener('touchstart', armIdle, { passive: true });
        root.addEventListener('focusin', armIdle);

        root.addEventListener('keydown', function (e) {
            if (e.target !== root && e.target !== video) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            var handled = true;
            switch (e.key) {
                case ' ': case 'k': togglePlay(); break;
                case 'ArrowLeft': video.currentTime = Math.max(0, video.currentTime - 5); break;
                case 'ArrowRight': video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5); break;
                case 'ArrowUp': volume.value = String(Math.min(1, Number(volume.value) + 0.05)); muted = false; applyVolume(); break;
                case 'ArrowDown': volume.value = String(Math.max(0, Number(volume.value) - 0.05)); applyVolume(); break;
                case 'm': muted = !muted; applyVolume(); break;
                case 'f': toggleFullscreen(); break;
                case 'c':
                    if (subs.length > 0) {
                        setSubs(currentSub + 1 >= subs.length ? -1 : currentSub + 1);
                        savePrefs({ subs: currentSub >= 0 ? subs[currentSub].lang : '' });
                    }
                    break;
                default: handled = false;
            }
            if (handled) { e.preventDefault(); armIdle(); }
        });
        root.addEventListener('click', function (e) { if (e.target === video) root.focus({ preventScroll: true }); });
    });
})();
`;
