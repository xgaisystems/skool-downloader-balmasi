import fs from 'fs-extra';
import path from 'path';
import { formatDate, resolveDownloadsDir } from './utils.js';
import { renderLessonProgressScript, renderProgressScript } from './progress-sync.js';
import { Downloader } from './downloader.js';
import { findLessonVideo, readTracksManifest, tracksSummary } from './media-tracks.js';
import { renderVideoPlayer, replaceVideoPlayer } from './video-player.js';
import { createConsoleLogger } from './logger.js';

type CourseManifest = {
    courseName: string;
    groupName: string;
    courseImageUrl?: string;
    courseImagePath?: string;
    modules: Array<{
        index: number;
        title: string;
        moduleDirName: string;
    }>;
    updatedAt: string;
};

type LessonManifest = {
    lessonId: string;
    title: string;
    moduleIndex: number;
    moduleTitle: string;
    lessonIndex: number;
    moduleDirName: string;
    lessonDirName: string;
    relativePath: string;
    hasVideo: boolean;
    resourcesCount: number;
    updatedAt: string;
};

async function writeAtomicHtml(filePath: string, content: string) {
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, content);
    await fs.move(tempPath, filePath, { overwrite: true });
}

/**
 * Regenerates the master index.html by scanning the downloads directory
 * for existing lesson files. Useful for recovering from interrupted downloads.
 */
type RegenerateOptions = {
    silent?: boolean;
    // Adds the "done" tick and progress script to lesson pages saved by older
    // versions. Off for the regeneration that runs after every lesson of a
    // download: those pages already have both, and patching all of them each
    // time rewrote every lesson page once per lesson finished.
    patchLessons?: boolean;
};

/**
 * For a lesson with a video (`video.mp4`, or one put there by hand under its
 * own name, `findLessonVideo()`): takes out its audio tracks and
 * subtitles (`prepareTracks()`, which also lists files added since) and
 * rebuilds the page's player from them, and records the video in
 * `lesson.json`. This is how a video put in the folder by hand, or subtitles
 * improved later, reach the page without visiting Skool.
 */
async function refreshVideoPlayer(lessonDir: string, html: string, downloader: Downloader): Promise<string> {
    const videoName = await findLessonVideo(lessonDir);
    if (videoName === null) return html;
    await downloader.prepareTracks(lessonDir, videoName);

    const manifestPath = path.join(lessonDir, 'lesson.json');
    try {
        const manifest = await fs.readJson(manifestPath);
        const media = tracksSummary(await readTracksManifest(lessonDir, videoName));
        const updated = {
            ...manifest,
            hasVideo: true,
            ...(videoName !== 'video' ? { videoFile: `${videoName}.mp4` } : {}),
            ...(media ? { media } : {})
        };
        if (JSON.stringify(updated) !== JSON.stringify(manifest)) await fs.writeJson(manifestPath, updated, { spaces: 2 });
    } catch {
        // No lesson.json: the course index falls back to the folder names.
    }

    const player = await renderVideoPlayer(lessonDir, videoName);
    const replaced = replaceVideoPlayer(html, player, `${videoName}.mp4`);
    if (replaced !== null) return replaced;
    // A page saved without a video: the player goes under the title.
    return html.replace(/(<h1>[\s\S]*?<\/h1>)/, (h1: string) => `${h1}\n${player}`);
}

async function patchLessonHtml(indexPath: string, lessonId: string, downloader: Downloader) {
    if (!await fs.pathExists(indexPath)) return;
    try {
        const original = await fs.readFile(indexPath, 'utf-8');
        let html = await refreshVideoPlayer(path.dirname(indexPath), original, downloader);

        const buttonHtml = `<button type="button" class="lesson-title-tick" id="lessonTickBtn" data-lesson-id="${lessonId}" title="Marcar como realizada" aria-label="Marcar como realizada"><svg viewBox="0 0 20 20" fill="none"><path d="M4.5 10.5L8 14L15.5 5.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;

        if (!html.includes('.lesson-title-tick {')) {
            const css = `
                                    .lesson-title-tick {
                                        display: inline-flex;
                                        align-items: center;
                                        justify-content: center;
                                        width: 34px;
                                        height: 34px;
                                        border-radius: 50%;
                                        background: #ffffff;
                                        border: 2.5px solid #cbd5e1;
                                        color: #94a3b8;
                                        margin-left: 14px;
                                        vertical-align: middle;
                                        cursor: pointer;
                                        transition: all 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                                        padding: 0;
                                        position: relative;
                                        top: -3px;
                                        flex-shrink: 0;
                                        box-shadow: 0 2px 6px rgba(15, 23, 42, 0.06);
                                    }
                                    .lesson-title-tick svg { width: 18px; height: 18px; }
                                    .lesson-title-tick:hover { border-color: #94a3b8; color: #64748b; transform: scale(1.12); }
                                    .lesson-title-tick.is-completed {
                                        background: #10b981;
                                        border-color: #10b981;
                                        color: #ffffff;
                                        box-shadow: 0 3px 12px rgba(16, 185, 129, 0.45);
                                        animation: tickPop 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                                    }
                                    @keyframes tickPop {
                                        0% { transform: scale(0.8); }
                                        50% { transform: scale(1.18); }
                                        100% { transform: scale(1); }
                                    }
`;
            if (html.includes('</style>')) {
                html = html.replace('</style>', `${css}                                </style>`);
            }
        }

        if (html.includes('class="lesson-title-tick"')) {
            html = html.replace(/<button[^>]*class="lesson-title-tick"[^>]*>[\s\S]*?<\/button>/, buttonHtml);
        } else if (/<h1[^>]*>([\s\S]*?)<\/h1>/.test(html)) {
            html = html.replace(/<h1([^>]*)>([\s\S]*?)<\/h1>/, (match, attrs, content) => {
                return `<h1${attrs}>${content.trim()} ${buttonHtml}</h1>`;
            });
        }

        if (!html.includes('.sync-pill')) {
            const css = `
                                    .sync-pill {
                                        position: fixed;
                                        bottom: 18px;
                                        right: 18px;
                                        z-index: 99999;
                                        display: inline-flex;
                                        align-items: center;
                                        gap: 8px;
                                        padding: 7px 14px;
                                        background: #0f172a;
                                        color: #f8fafc;
                                        font-size: 0.8rem;
                                        font-weight: 500;
                                        border-radius: 9999px;
                                        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
                                        border: 1px solid rgba(255, 255, 255, 0.14);
                                        font-family: inherit;
                                        transition: all 0.25s ease;
                                        user-select: none;
                                    }
                                    .sync-pill .sync-dot {
                                        width: 8px;
                                        height: 8px;
                                        border-radius: 50%;
                                        background: #f59e0b;
                                        flex-shrink: 0;
                                        transition: background 0.2s ease, box-shadow 0.2s ease;
                                    }
                                    .sync-pill.is-connected .sync-dot {
                                        background: #10b981;
                                        box-shadow: 0 0 8px #10b981;
                                    }
                                    .sync-pill a {
                                        color: #38bdf8;
                                        text-decoration: none;
                                        font-weight: 600;
                                    }
                                    .sync-pill a:hover {
                                        text-decoration: underline;
                                    }
`;
            if (html.includes('</style>')) {
                html = html.replace('</style>', `${css}                                </style>`);
            }
        }

        const script = renderLessonProgressScript();
        // Within one script element: a lazy `[\s\S]*?` from the first
        // `<script>` ran on through any script before this one (the video
        // player's) and deleted it.
        const progressScript = /<script>(?:(?!<\/script>)[\s\S])*?STORAGE_KEY\s*=\s*'cerebro_completed_lessons'[\s\S]*?<\/script>/;
        if (progressScript.test(html)) {
            html = html.replace(progressScript, () => script.trim());
        } else if (html.includes('</body>')) {
            html = html.replace('</body>', `${script}\n                            </body>`);
        }

        // The button and script are always swapped for the current version,
        // so compare instead of tracking whether anything was replaced.
        if (html !== original) {
            await writeAtomicHtml(indexPath, html);
        }
    } catch {}
}

async function regenerateIndex(
    downloadsDir: string = resolveDownloadsDir(),
    options: RegenerateOptions = {}
) {
    const log = options.silent ? () => {} : console.log;
    const warn = options.silent ? () => {} : console.warn;
    // Only used for lessons with a video, when lesson pages are patched.
    const downloader = new Downloader(createConsoleLogger({ silent: options.silent }));

    if (!fs.existsSync(downloadsDir)) {
        log(`❌ Downloads directory not found: ${downloadsDir}`);
        return;
    }

    const courseDirName = path.basename(downloadsDir);
    log(`🔍 Scanning downloads directory: ${downloadsDir}`);

    let courseManifest: CourseManifest | null = null;
    const courseManifestPath = path.join(downloadsDir, '.course.json');
    if (await fs.pathExists(courseManifestPath)) {
        try {
            courseManifest = await fs.readJson(courseManifestPath);
        } catch (err) {
            warn('⚠️ Failed to read course manifest, falling back to directory names.');
        }
    }

    // Read all module directories and root-level lesson directories
    const entries = await fs.readdir(downloadsDir, { withFileTypes: true });
    const moduleDirs: typeof entries = [];
    const rootLessonDirs: typeof entries = [];

    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'assets') continue;
        const entryPath = path.join(downloadsDir, entry.name);
        const indexPath = path.join(entryPath, 'index.html');
        const manifestPath = path.join(entryPath, 'lesson.json');
        if (await fs.pathExists(indexPath) || await fs.pathExists(manifestPath)) {
            rootLessonDirs.push(entry);
        } else {
            moduleDirs.push(entry);
        }
    }

    moduleDirs.sort((a, b) => {
        // Extract module number from directory name (e.g., "1-Module Name")
        const numA = parseInt(a.name.split('-')[0]) || 999;
        const numB = parseInt(b.name.split('-')[0]) || 999;
        return numA - numB;
    });

    const courseInfo: any[] = [];

    for (const moduleDir of moduleDirs) {
        const modulePath = path.join(downloadsDir, moduleDir.name);

        // Extract module title (remove the number prefix)
        const moduleTitle = moduleDir.name.replace(/^\d+-/, '');
        const moduleIndex = parseInt(moduleDir.name.split('-')[0]) || 999;

        // Read lesson directories
        const lessonEntries = await fs.readdir(modulePath, { withFileTypes: true });
        const lessonDirs = lessonEntries
            .filter(entry => entry.isDirectory())
            .sort((a, b) => {
                // Extract lesson number from directory name
                const numA = parseInt(a.name.split('-')[0]) || 999;
                const numB = parseInt(b.name.split('-')[0]) || 999;
                return numA - numB;
            });

        const lessons: any[] = [];

        for (const lessonDir of lessonDirs) {
            const lessonPath = path.join(modulePath, lessonDir.name);
            const indexPath = path.join(lessonPath, 'index.html');
            const manifestPath = path.join(lessonPath, 'lesson.json');

            // Check if lesson has an index.html
            if (fs.existsSync(indexPath)) {
                let lessonTitle = lessonDir.name.replace(/^\d+-/, '');
                let relativePath = `${moduleDir.name}/${lessonDir.name}/index.html`;
                let lessonIndex = parseInt(lessonDir.name.split('-')[0]) || 999;
                let moduleTitleOverride: string | null = null;
                let moduleIndexOverride: number | null = null;

                if (fs.existsSync(manifestPath)) {
                    try {
                        const manifest: LessonManifest = await fs.readJson(manifestPath);
                        lessonTitle = manifest.title || lessonTitle;
                        relativePath = manifest.relativePath || relativePath;
                        lessonIndex = manifest.lessonIndex ?? lessonIndex;
                        moduleTitleOverride = manifest.moduleTitle || null;
                        moduleIndexOverride = manifest.moduleIndex ?? null;
                    } catch (err) {
                        warn(`⚠️ Failed to read manifest for ${lessonDir.name}, using directory data.`);
                    }
                }

                lessons.push({
                    title: lessonTitle,
                    path: relativePath,
                    index: lessonIndex,
                    moduleTitleOverride,
                    moduleIndexOverride
                });

                if (options.patchLessons !== false) {
                    await patchLessonHtml(indexPath, `${courseDirName}/${relativePath.replace(/\\/g, '/')}`, downloader);
                }
            }
        }

        if (lessons.length > 0) {
            lessons.sort((a, b) => a.index - b.index);
            const resolvedModuleTitle = lessons.find(l => l.moduleTitleOverride)?.moduleTitleOverride || moduleTitle;
            const resolvedModuleIndex = lessons.find(l => l.moduleIndexOverride)?.moduleIndexOverride ?? moduleIndex;
            courseInfo.push({
                title: resolvedModuleTitle,
                lessons: lessons,
                index: resolvedModuleIndex,
                moduleDirName: moduleDir.name
            });
        }
    }

    if (rootLessonDirs.length > 0) {
        rootLessonDirs.sort((a, b) => {
            const numA = parseInt(a.name.split('-')[0]) || 999;
            const numB = parseInt(b.name.split('-')[0]) || 999;
            return numA - numB;
        });

        const lessons: any[] = [];

        for (const lessonDir of rootLessonDirs) {
            const lessonPath = path.join(downloadsDir, lessonDir.name);
            const indexPath = path.join(lessonPath, 'index.html');
            const manifestPath = path.join(lessonPath, 'lesson.json');

            if (fs.existsSync(indexPath)) {
                let lessonTitle = lessonDir.name.replace(/^\d+-/, '');
                let relativePath = `${lessonDir.name}/index.html`;
                let lessonIndex = parseInt(lessonDir.name.split('-')[0]) || 999;
                let moduleTitleOverride: string | null = null;
                let moduleIndexOverride: number | null = null;

                if (fs.existsSync(manifestPath)) {
                    try {
                        const manifest: LessonManifest = await fs.readJson(manifestPath);
                        lessonTitle = manifest.title || lessonTitle;
                        relativePath = manifest.relativePath || relativePath;
                        lessonIndex = manifest.lessonIndex ?? lessonIndex;
                        moduleTitleOverride = manifest.moduleTitle || null;
                        moduleIndexOverride = manifest.moduleIndex ?? null;
                    } catch (err) {
                        warn(`⚠️ Failed to read manifest for ${lessonDir.name}, using directory data.`);
                    }
                }

                lessons.push({
                    title: lessonTitle,
                    path: relativePath,
                    index: lessonIndex,
                    moduleTitleOverride,
                    moduleIndexOverride
                });

                if (options.patchLessons !== false) {
                    await patchLessonHtml(indexPath, `${courseDirName}/${relativePath.replace(/\\/g, '/')}`, downloader);
                }
            }
        }

        if (lessons.length > 0) {
            lessons.sort((a, b) => a.index - b.index);
            const resolvedModuleTitle = lessons.find(l => l.moduleTitleOverride)?.moduleTitleOverride || 'Lessons';
            const resolvedModuleIndex = lessons.find(l => l.moduleIndexOverride)?.moduleIndexOverride ?? 0;
            courseInfo.push({
                title: resolvedModuleTitle,
                lessons: lessons,
                index: resolvedModuleIndex,
                moduleDirName: ''
            });
        }
    }

    courseInfo.sort((a, b) => {
        if (a.index !== b.index) return a.index - b.index;
        if (courseManifest?.modules?.length) {
            const order = new Map(courseManifest.modules.map((m, i) => [m.moduleDirName, i]));
            const orderA = order.get(a.moduleDirName) ?? 9999;
            const orderB = order.get(b.moduleDirName) ?? 9999;
            if (orderA !== orderB) return orderA - orderB;
        }
        return (a.title || '').localeCompare(b.title || '');
    });

    const courseName = courseManifest?.courseName || 'Course Archive';
    const groupName = courseManifest?.groupName || '';
    let courseImagePath = courseManifest?.courseImagePath;
    if (!courseImagePath) {
        for (const ext of [".jpg", ".jpeg", ".png", ".webp"]) {
            if (await fs.pathExists(path.join(downloadsDir, `assets/course-cover${ext}`))) {
                courseImagePath = `assets/course-cover${ext}`;
                break;
            }
        }
    }
    const resolvedCourseImagePath = courseImagePath
        ? path.join(downloadsDir, courseImagePath)
        : null;
    const hasCourseImage = resolvedCourseImagePath ? await fs.pathExists(resolvedCourseImagePath) : false;

    // Generate the index HTML
    const indexHtml = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>${courseName}${groupName ? ` (${groupName})` : ''} - Backup</title>
                <style>
                    :root {
                        --bg: #f6f3ee;
                        --panel: #ffffff;
                        --panel-2: #f6f7fb;
                        --text: #14161d;
                        --muted: #596070;
                        --accent: #3b82f6;
                        --accent-2: #0f172a;
                        --ring: rgba(20,22,29,0.08);
                        --shadow: 0 20px 40px rgba(15, 23, 42, 0.12);
                    }
                    * { box-sizing: border-box; }
                    body {
                        margin: 0;
                        font-family: "Space Grotesk", "Manrope", "Segoe UI", sans-serif;
                        background: linear-gradient(145deg, #fefefe 0%, #f3f6fb 100%);
                        color: var(--text);
                        line-height: 1.6;
                    }
                    .page {
                        max-width: 1100px;
                        margin: 48px auto 80px;
                        padding: 0 24px;
                    }
                    .hero {
                        display: grid;
                        grid-template-columns: 1fr;
                        gap: 28px;
                        align-items: center;
                        background: var(--panel);
                        border-radius: 28px;
                        padding: 32px;
                        box-shadow:
                            0 20px 45px rgba(15, 23, 42, 0.18),
                            0 10px 20px rgba(15, 23, 42, 0.08);
                    }
                    .breadcrumb {
                        font-size: 0.95rem;
                        color: var(--muted);
                        margin-bottom: 18px;
                        display: flex;
                        flex-wrap: wrap;
                        gap: 8px;
                        align-items: center;
                    }
                    .breadcrumb a { color: var(--accent); text-decoration: none; font-weight: 600; }
                    .breadcrumb span { color: var(--muted); }
                    .hero-copy {
                        display: flex;
                        flex-direction: column;
                        justify-content: center;
                        gap: 6px;
                    }
                    .hero-title {
                        font-size: clamp(2.2rem, 4vw, 3.2rem);
                        margin: 0 0 10px 0;
                        letter-spacing: -0.02em;
                    }
                    .hero-subtitle {
                        color: var(--muted);
                        margin: 0 0 22px 0;
                        font-size: 1.05rem;
                    }
                    .hero-meta {
                        display: flex;
                        flex-wrap: wrap;
                        gap: 12px;
                    }
                    .chip {
                        padding: 10px 14px;
                        border-radius: 999px;
                        background: var(--panel-2);
                        border: 1px solid var(--ring);
                        color: var(--text);
                        font-size: 0.95rem;
                    }
                    .chip strong { color: var(--accent); font-weight: 700; }
                    .hero-image {
                        position: relative;
                        border-radius: 18px;
                        overflow: hidden;
                        background: #020617;
                        border: 1px solid var(--ring);
                        box-shadow: 0 16px 28px rgba(15, 23, 42, 0.14);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        align-self: center;
                        width: 100%;
                        max-height: 320px;
                    }
                    .hero-image img {
                        width: 100%;
                        height: auto;
                        max-height: 320px;
                        object-fit: contain;
                        display: block;
                    }
                    .hero-image .fallback {
                        height: 100%;
                        display: grid;
                        place-items: center;
                        color: var(--muted);
                        font-size: 0.95rem;
                    }
                    .content {
                        margin-top: 36px;
                        display: grid;
                        gap: 18px;
                    }
                    .module {
                        background: var(--panel);
                        border-radius: 20px;
                        padding: 22px;
                        transition: transform 0.25s ease, box-shadow 0.25s ease;
                        box-shadow: 0 20px 40px rgba(15, 23, 42, 0.1);
                    }
                    .module:hover {
                        transform: translateY(-4px);
                        box-shadow:
                            0 30px 60px rgba(15, 23, 42, 0.18),
                            0 12px 24px rgba(15, 23, 42, 0.1);
                    }
                    .module-title {
                        margin: 0 0 12px 0;
                        font-size: 1.25rem;
                        display: flex;
                        align-items: center;
                        gap: 10px;
                    }
                    .module-title span {
                        color: var(--accent-2);
                        font-weight: 700;
                        font-size: 0.95rem;
                        padding: 4px 10px;
                        border-radius: 999px;
                        background: rgba(37,99,235,0.12);
                        border: 1px solid rgba(37,99,235,0.25);
                    }
                    .lesson-list {
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
                        gap: 12px 16px;
                        align-items: stretch;
                        grid-auto-flow: row dense;
                        padding: 0;
                        margin: 0;
                        list-style: none;
                    }
                    .lesson a {
                        display: flex;
                        align-items: center;
                        justify-content: space-between;
                        gap: 12px;
                        padding: 12px 14px;
                        border-radius: 14px;
                        background: var(--panel-2);
                        border: 1px solid rgba(255,255,255,0.2);
                        color: var(--text);
                        text-decoration: none;
                        font-size: 0.98rem;
                        min-height: 46px;
                        height: 100%;
                        transition: border-color 0.25s ease, transform 0.25s ease;
                        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.15);
                    }
                    .lesson a:hover {
                        border-color: rgba(59,130,246,0.6);
                        transform: translateY(-2px);
                    }
                    .lesson-title-text {
                        flex: 1;
                    }
                    .course-tick {
                        display: inline-flex;
                        align-items: center;
                        justify-content: center;
                        width: 22px;
                        height: 22px;
                        min-width: 22px;
                        border-radius: 50%;
                        background: #ffffff;
                        border: 2px solid #cbd5e1;
                        color: #94a3b8;
                        margin-left: auto;
                        cursor: pointer;
                        transition: all 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                        padding: 0;
                        flex-shrink: 0;
                        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
                    }
                    .course-tick svg {
                        width: 13px;
                        height: 13px;
                    }
                    .course-tick:hover {
                        border-color: #94a3b8;
                        color: #64748b;
                        transform: scale(1.15);
                    }
                    .course-tick.is-completed {
                        background: #10b981;
                        border-color: #10b981;
                        color: #ffffff;
                        box-shadow: 0 2px 8px rgba(16, 185, 129, 0.4);
                        animation: tickPop 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                    }
                    @keyframes tickPop {
                        0% { transform: scale(0.8); }
                        50% { transform: scale(1.18); }
                        100% { transform: scale(1); }
                    }
                    .sync-pill {
                        position: fixed;
                        bottom: 18px;
                        right: 18px;
                        z-index: 99999;
                        display: inline-flex;
                        align-items: center;
                        gap: 8px;
                        padding: 7px 14px;
                        background: #0f172a;
                        color: #f8fafc;
                        font-size: 0.8rem;
                        font-weight: 500;
                        border-radius: 9999px;
                        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
                        border: 1px solid rgba(255, 255, 255, 0.14);
                        font-family: inherit;
                        transition: all 0.25s ease;
                        user-select: none;
                    }
                    .sync-pill .sync-dot {
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                        background: #f59e0b;
                        flex-shrink: 0;
                        transition: background 0.2s ease, box-shadow 0.2s ease;
                    }
                    .sync-pill.is-connected .sync-dot {
                        background: #10b981;
                        box-shadow: 0 0 8px #10b981;
                    }
                    .sync-pill a {
                        color: #38bdf8;
                        text-decoration: none;
                        font-weight: 600;
                    }
                    .sync-pill a:hover {
                        text-decoration: underline;
                    }
                    @media (min-width: 900px) {
                        .hero { grid-template-columns: 1.15fr 0.85fr; }
                    }
                    @media (max-width: 640px) {
                        .hero-image { min-height: auto; }
                    }
                </style>
            </head>
            <body>
                <div class="page">
                    ${groupName ? `
                        <div class="breadcrumb">
                            <a href="../index.html">${groupName}</a>
                            <span>/</span>
                            <span>${courseName}</span>
                        </div>
                    ` : ''}
                    <section class="hero">
                        <div class="hero-copy">
                            <h1 class="hero-title">${courseName}</h1>
                            <p class="hero-subtitle">${groupName ? `Community: ${groupName}` : 'Course Archive'}</p>
                            <div class="hero-meta">
                                <div class="chip" id="courseProgressChip">Progreso: <strong>0 / ${courseInfo.reduce((acc, m) => acc + m.lessons.length, 0)}</strong> completadas</div>
                                <div class="chip"><strong>${courseInfo.reduce((acc, m) => acc + m.lessons.length, 0)}</strong> lessons</div>
                                <div class="chip"><strong>${courseInfo.length}</strong> modules</div>
                                <div class="chip">Updated: <strong>${formatDate(courseManifest?.updatedAt || new Date())}</strong></div>
                            </div>
                        </div>
                        <div class="hero-image">
                            ${hasCourseImage && courseImagePath
        ? `<img src="${courseImagePath}" alt="${courseName} cover">`
        : `<div class="fallback">No course image available</div>`}
                        </div>
                    </section>

                    <section class="content">
                        ${courseInfo.map(m => `
                            <div class="module">
                                <h2 class="module-title"><span>Module ${m.index}</span>${m.title}</h2>
                                <ul class="lesson-list">
                                    ${m.lessons.map((l: any) => `
                                        <li class="lesson">
                                            <a href="${l.path}">
                                                <span class="lesson-title-text">${l.title}</span>
                                                <span class="course-tick" data-lesson-id="${courseDirName}/${l.path.replace(/\\/g, '/')}" role="button" title="Marcar como realizada" aria-label="Marcar como realizada">
                                                    <svg viewBox="0 0 20 20" fill="none"><path d="M4.5 10.5L8 14L15.5 5.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                                                </span>
                                            </a>
                                        </li>
                                    `).join('')}
                                </ul>
                            </div>
                        `).join('')}
                    </section>
                </div>
                ${renderProgressScript(`
    function render(data) {
        const ticks = document.querySelectorAll('.course-tick');
        let count = 0;
        ticks.forEach(t => {
            const isDone = !!data[t.getAttribute('data-lesson-id')];
            t.classList.toggle('is-completed', isDone);
            t.setAttribute('aria-pressed', isDone ? 'true' : 'false');
            t.setAttribute('title', isDone ? 'Completada (clic para desmarcar)' : 'Marcar como realizada');
            if (isDone) count++;
        });
        const chip = document.getElementById('courseProgressChip');
        if (chip) chip.innerHTML = 'Progreso: <strong>' + count + ' / ' + ticks.length + '</strong> completadas';
    }

    document.addEventListener('click', (e) => {
        const tick = e.target.closest('.course-tick');
        if (!tick) return;
        e.preventDefault();
        e.stopPropagation();
        const id = tick.getAttribute('data-lesson-id');
        const data = getCompleted();
        if (data[id]) delete data[id]; else data[id] = true;
        saveCompleted(data, true);
        render(data);
    });

    startProgressSync(render);
`)}
            </body>
            </html>
        `;

    // Write the index file
    await writeAtomicHtml(path.join(downloadsDir, 'index.html'), indexHtml);

    log('\n✅ Index regenerated successfully!');
    log(`📊 Found ${courseInfo.length} modules with ${courseInfo.reduce((acc, m) => acc + m.lessons.length, 0)} lessons total`);
    log(`📁 Saved to: ${path.join(downloadsDir, 'index.html')}`);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const downloadsDir = process.argv[2] || resolveDownloadsDir();
    regenerateIndex(downloadsDir).catch(console.error);
}

export { regenerateIndex };
