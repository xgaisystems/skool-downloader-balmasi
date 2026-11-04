import { Scraper, Module } from './scraper.js';
import { Downloader, summarizeVideoError } from './downloader.js';
import { LINKED_POSTS_CSS, renderLinkedPosts, renderLinkedPostSource, type PostLinkResolver } from './linked-posts.js';
import { saveLinkedPost, type LinkedPostManifest, type SavedLinkedPost } from './linked-post-archive.js';
import { sanitizeName } from './utils.js';
import { renderLessonProgressScript } from './progress-sync.js';
import { regenerateIndex } from './regenerate-index.js';
import { regenerateGroupIndex } from './regenerate-group-index.js';
import { createConsoleLogger, type Logger } from './logger.js';
import fs from 'fs-extra';
import path from 'path';
import pLimit from 'p-limit';

const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 16;

const indexLimit = pLimit(1);
const groupIndexLimit = pLimit(1);
let activeOutputDir: string | null = null;
let activeGroupDir: string | null = null;
let shutdownHandlersRegistered = false;

function registerShutdownHandlers(logger: Logger) {
    if (shutdownHandlersRegistered) return;
    shutdownHandlersRegistered = true;

    const handleShutdown = async (signal: string) => {
        // 128 + signal number, what a shell reports for an interrupted command.
        const exitCode = signal === 'SIGINT' ? 130 : 143;
        if (!activeOutputDir) {
            process.exit(exitCode);
            return;
        }
        logger.warn(`\n🛑 Caught ${signal}. Regenerating index before exit...`);
        const outputDir = activeOutputDir;
        const groupDir = activeGroupDir;
        try {
            // Through the same queues as the regular regenerations, so this
            // never writes index.html.tmp at the same time as one of them. The
            // per-lesson ones still waiting are dropped: this one covers them.
            indexLimit.clearQueue();
            groupIndexLimit.clearQueue();
            await indexLimit(() => regenerateIndex(outputDir, { patchLessons: false }));
            if (groupDir) {
                await groupIndexLimit(() => regenerateGroupIndex(groupDir));
            }
        } catch (err) {
            logger.error('⚠️ Failed to regenerate index during shutdown.', err);
        } finally {
            process.exit(exitCode);
        }
    };

    process.once('SIGINT', () => { void handleShutdown('SIGINT'); });
    process.once('SIGTERM', () => { void handleShutdown('SIGTERM'); });
}

type CourseManifest = {
    courseName: string;
    groupName: string;
    // Order of the course in the community's classroom, used by the group index.
    position?: number;
    courseImageUrl?: string;
    courseImagePath?: string;
    modules: Array<{
        index: number;
        title: string;
        moduleDirName: string;
        root?: boolean;
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
    videoError?: string;
    // Set when the run skipped videos: where the lesson's video comes from (its
    // link, or `skool:<id>` for Skool-hosted videos), to match one added later.
    videoSkipped?: boolean;
    videoSource?: string;
    resourcesCount: number;
    linkedPosts?: LinkedPostManifest[];
    updatedAt: string;
};

export type DownloadMode = 'auto' | 'course' | 'lesson';

export type DownloadCallbacks = {
    onCourseStart?: (info: {
        courseName: string;
        groupName: string;
        modulesCount: number;
        lessonsCount: number;
        outputDir: string;
        targetLessonId: string | null;
        lessonDestination?: {
            moduleIndex: number;
            moduleTitle: string;
            moduleDirName: string;
            lessonIndex: number;
            lessonTitle: string;
            lessonDirName: string;
            lessonOutputDir: string;
            lessonRelativePath: string;
        } | null;
    }) => void;
    onLessonStart?: (info: {
        moduleIndex: number;
        lessonIndex: number;
        lessonTitle: string;
    }) => void;
    onLessonComplete?: (info: {
        moduleIndex: number;
        lessonIndex: number;
        lessonTitle: string;
        hasVideo: boolean;
        resourcesCount: number;
    }) => void;
    onLessonError?: (info: {
        moduleIndex: number;
        lessonIndex: number;
        lessonTitle: string;
        error: unknown;
    }) => void;
    onCourseComplete?: (summary: DownloadSummary) => void;
};

export type DownloadOptions = {
    url: string;
    outputDir?: string;
    concurrency?: number;
    mode?: DownloadMode;
    lessonId?: string | null;
    logger?: Logger;
    callbacks?: DownloadCallbacks;
    suppressIndexLogs?: boolean;
    // Save lessons without downloading their videos. A video.mp4 already in the
    // lesson folder is kept and still shown on the page.
    skipVideos?: boolean;
    runTasks?: (tasks: LessonTask[], concurrency: number) => Promise<void>;
};

export type LessonFailure = {
    lessonTitle: string;
    lessonUrl: string;
    lessonDir: string;
    kind: 'lesson' | 'video';
    reason: string;
    videoUrl?: string;
};

export type DownloadSummary = {
    courseName: string;
    groupName: string;
    outputDir: string;
    modulesCount: number;
    lessonsCount: number;
    completedLessons: number;
    failedLessons: number;
    failedVideos: number;
    failures: LessonFailure[];
    targetLessonId: string | null;
};

export type LessonTask = {
    title: string;
    run: (onStatus?: (message: string) => void) => Promise<void>;
};

async function writeAtomicJson(filePath: string, data: unknown) {
    const tempPath = `${filePath}.tmp`;
    await fs.writeJson(tempPath, data, { spaces: 2 });
    await fs.move(tempPath, filePath, { overwrite: true });
}

function getUrlExtension(url: string) {
    try {
        const ext = path.extname(new URL(url).pathname);
        if (ext && ext.length <= 5) return ext;
    } catch (err) {
        // Ignore parsing errors, fallback below.
    }
    return '.jpg';
}


// Posts link to lessons as obj://course/<lesson id>?cn=<course key>. A lesson
// of this course that is saved, or being saved in this run, gets a relative
// link from `fromDir`; any other one links to Skool.
function createLessonLinkResolver(
    lessonDirs: Map<string, string>,
    willSave: Set<string>,
    groupUrl: string
): (fromDir: string) => PostLinkResolver {
    return (fromDir) => (href) => {
        const match = href.match(/^obj:\/\/course\/([0-9a-f]+)(?:\?(.*))?$/i);
        if (!match) return undefined;
        const lessonId = match[1]!;
        const lessonDir = lessonDirs.get(lessonId);
        if (lessonDir && (willSave.has(lessonId) || fs.existsSync(path.join(lessonDir, 'index.html')))) {
            return path.relative(fromDir, path.join(lessonDir, 'index.html')).split(path.sep).map(encodeURIComponent).join('/');
        }
        const courseKey = new URLSearchParams(match[2] ?? '').get('cn');
        return courseKey ? `${groupUrl}/classroom/${encodeURIComponent(courseKey)}?md=${lessonId}` : undefined;
    };
}

function resolveTargetLessonId(
    url: string,
    mode: DownloadMode,
    explicitLessonId?: string | null
) {
    if (mode === 'course') return null;

    let targetLessonId = explicitLessonId ?? null;
    try {
        const urlObj = new URL(url);
        if (!targetLessonId) {
            targetLessonId = urlObj.searchParams.get('md') || urlObj.searchParams.get('lesson');
        }
    } catch (err) {
        // Ignore parsing errors, caller will validate.
    }

    if (mode === 'lesson' && !targetLessonId) {
        throw new Error('Lesson mode requires a lesson id in the URL or explicit lessonId option.');
    }

    return targetLessonId;
}

function normalizeConcurrency(value: number | undefined) {
    if (!Number.isFinite(value) || value === undefined) return DEFAULT_CONCURRENCY;
    const floored = Math.floor(value);
    if (floored <= 0) return DEFAULT_CONCURRENCY;
    return Math.min(MAX_CONCURRENCY, floored);
}

async function runConcurrent(tasks: Array<() => Promise<void>>, concurrency: number) {
    if (tasks.length === 0) return;
    if (concurrency <= 1 || tasks.length === 1) {
        for (const task of tasks) {
            await task().catch(() => {});
        }
        return;
    }

    let index = 0;
    const workerCount = Math.min(concurrency, tasks.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const current = index;
            index += 1;
            if (current >= tasks.length) return;
            await tasks[current]().catch(() => {});
        }
    });

    await Promise.all(workers);
}

export async function downloadCourse(options: DownloadOptions): Promise<DownloadSummary> {
    const logger = options.logger ?? createConsoleLogger();
    const concurrency = normalizeConcurrency(options.concurrency);
    const mode = options.mode ?? 'auto';
    const inputUrl = options.url.replace(/\\/g, '');

    let classroomUrl = inputUrl;
    try {
        classroomUrl = new URL(inputUrl).toString();
    } catch (err) {
        throw new Error(`Invalid URL: ${inputUrl}`);
    }

    const targetLessonId = resolveTargetLessonId(classroomUrl, mode, options.lessonId);
    classroomUrl = classroomUrl.split('?')[0];

    const scraper = new Scraper(logger);
    const downloader = new Downloader(logger);

    let completedLessons = 0;
    let failedLessons = 0;
    const failures: LessonFailure[] = [];

    try {
        logger.info('🚀 Fetching course structure...');
        let { modules, courseName, groupName, courseImageUrl, coursePosition } = await scraper.parseClassroom(classroomUrl);

        if (modules.length === 0) {
            throw new Error('No modules found. Are you sure this is a classroom URL and you are logged in?');
        }

        // Folder of every lesson of the course, relative to the course folder,
        // taken before single-lesson mode drops the others.
        const lessonRelativeDirs = new Map<string, string>();
        for (const m of modules) {
            const moduleDirName = m.root ? '' : `${m.index}-${sanitizeName(m.title)}`;
            for (const l of m.lessons) {
                lessonRelativeDirs.set(l.id, path.join(moduleDirName, `${l.index ?? 1}-${sanitizeName(l.title)}`));
            }
        }

        if (targetLessonId) {
            logger.info(`📍 Single lesson mode: Finding lesson ${targetLessonId}...`);
            let found = false;
            for (const module of modules) {
                const lesson = module.lessons.find(l => l.id === targetLessonId);
                if (lesson) {
                    module.lessons = [lesson];
                    modules = [module];
                    found = true;
                    break;
                }
            }

            if (!found) {
                throw new Error(`Could not find lesson with ID ${targetLessonId} in this classroom.`);
            }

            logger.info(`✅ Found lesson: ${modules[0].lessons[0].title}`);
        } else {
            logger.info(`✅ Found ${modules.length} modules.`);
        }

        const sanitizedGroupName = sanitizeName(groupName);
        const sanitizedCourseName = sanitizeName(courseName);

        const defaultOutputDir = path.join(
            process.cwd(),
            'downloads',
            sanitizedGroupName,
            sanitizedCourseName
        );

        const outputOverride =
            options.outputDir && options.outputDir !== 'undefined'
                ? options.outputDir
                : undefined;
        const baseOutputDir = outputOverride || defaultOutputDir;
        if (!baseOutputDir) {
            throw new Error('Output directory resolution failed.');
        }

        await fs.ensureDir(baseOutputDir);
        activeOutputDir = baseOutputDir;
        activeGroupDir = path.dirname(baseOutputDir);
        registerShutdownHandlers(logger);

        const courseInfo: Array<{
            title: string;
            lessons: any[];
            totalLessons: number;
            mIndex: number;
            moduleDirName: string;
        }> = modules.map(m => ({
            title: m.title,
            lessons: [] as any[],
            totalLessons: m.lessons.length,
            mIndex: m.index,
            moduleDirName: m.root ? '' : `${m.index}-${sanitizeName(m.title)}`
        }));

        let lessonDestination: {
            moduleIndex: number;
            moduleTitle: string;
            moduleDirName: string;
            lessonIndex: number;
            lessonTitle: string;
            lessonDirName: string;
            lessonOutputDir: string;
            lessonRelativePath: string;
        } | null = null;

        if (targetLessonId && modules[0]?.lessons?.length) {
            const module = modules[0];
            const lesson = module.lessons[0];
            const moduleInfo = courseInfo[0];
            const lessonIndex = lesson.index ?? 1;
            const lessonDirName = `${lessonIndex}-${sanitizeName(lesson.title)}`;
            const lessonOutputDir = path.join(baseOutputDir, moduleInfo.moduleDirName, lessonDirName);
            lessonDestination = {
                moduleIndex: moduleInfo.mIndex,
                moduleTitle: moduleInfo.title,
                moduleDirName: moduleInfo.moduleDirName,
                lessonIndex,
                lessonTitle: lesson.title,
            lessonDirName,
            lessonOutputDir,
            lessonRelativePath: moduleInfo.moduleDirName
                ? `${moduleInfo.moduleDirName}/${lessonDirName}/index.html`
                : `${lessonDirName}/index.html`
        };
    }

        const totalLessons = modules.reduce((sum, module) => sum + module.lessons.length, 0);
        options.callbacks?.onCourseStart?.({
            courseName,
            groupName,
            modulesCount: modules.length,
            lessonsCount: totalLessons,
            outputDir: baseOutputDir,
            targetLessonId,
            lessonDestination
        });

        let courseImagePath: string | undefined;
        if (courseImageUrl) {
            try {
                const assetsDir = path.join(baseOutputDir, 'assets');
                await fs.ensureDir(assetsDir);
                const ext = getUrlExtension(courseImageUrl);
                const localName = `course-cover${ext}`;
                const localPath = path.join(assetsDir, localName);
                await downloader.downloadAsset(courseImageUrl, localPath);
                courseImagePath = `assets/${localName}`;
            } catch (err) {
                logger.warn('⚠️ Failed to download course image, continuing without it.');
            }
        }

        const courseManifest: CourseManifest = {
            courseName,
            groupName,
            position: coursePosition,
            courseImageUrl,
            courseImagePath,
            modules: courseInfo.map(m => ({
                index: m.mIndex,
                title: m.title,
                moduleDirName: m.moduleDirName,
                root: modules.find(mod => mod.index === m.mIndex)?.root
            })),
            updatedAt: new Date().toISOString()
        };

        await writeAtomicJson(path.join(baseOutputDir, '.course.json'), courseManifest);

        const classroomPath = new URL(classroomUrl);
        const groupUrl = `${classroomPath.origin}/${classroomPath.pathname.split('/').filter(Boolean)[0]}`;
        const linkResolver = createLessonLinkResolver(
            new Map([...lessonRelativeDirs].map(([id, dir]) => [id, path.join(baseOutputDir, dir)])),
            new Set(modules.flatMap(m => m.lessons.map(l => l.id))),
            groupUrl
        );

        const tasks: LessonTask[] = [];

        for (let i = 0; i < modules.length; i++) {
            const module = modules[i];
            const mInfo = courseInfo[i];
            const moduleDir = mInfo.moduleDirName ? path.join(baseOutputDir, mInfo.moduleDirName) : baseOutputDir;
            if (mInfo.moduleDirName) {
                await fs.ensureDir(moduleDir);
            }

            for (const lesson of module.lessons) {
                const lIndex = lesson.index ?? 1;
                const taskTitle = `[${mInfo.mIndex}.${lIndex}] ${lesson.title}`;
                tasks.push({
                    title: taskTitle,
                    run: async (onStatus) => {
                        const updateStatus = (message?: string) => {
                            if (!onStatus || !message) return;
                            onStatus(message);
                        };
                        const lessonDirName = `${lIndex}-${sanitizeName(lesson.title)}`;
                        const lessonDir = path.join(moduleDir, lessonDirName);

                        options.callbacks?.onLessonStart?.({
                            moduleIndex: mInfo.mIndex,
                            lessonIndex: lIndex,
                            lessonTitle: lesson.title
                        });

                        logger.info(`\n  📄 Processing [${mInfo.mIndex}.${lIndex}] ${lesson.title}`);

                        // Thrown after the lesson is saved so task renderers show it
                        // as failed instead of a green tick.
                        let taskError: Error | null = null;
                        try {
                            updateStatus('Loading lesson data...');
                            await fs.ensureDir(lessonDir);
                            const lessonData = await scraper.extractLessonData(lesson.url, { resolveNativeVideo: !options.skipVideos });

                            updateStatus('Localizing images...');
                            const localizedHtml = await downloader.localizeImages(lessonData.contentHtml || '', lessonDir);

                            let hasVideo = false;
                            let videoError: string | undefined;
                            const videoSource = lessonData.videoLink || (lessonData.videoId ? `skool:${lessonData.videoId}` : undefined);
                            const videoSkipped = Boolean(options.skipVideos && videoSource);
                            if (options.skipVideos) {
                                hasVideo = await fs.pathExists(path.join(lessonDir, 'video.mp4'));
                            } else if (lessonData.videoLink) {
                                try {
                                    updateStatus('Downloading video...');
                                    await downloader.downloadVideo(lessonData.videoLink, lessonDir, 'video');
                                    hasVideo = true;
                                } catch (err) {
                                    videoError = summarizeVideoError(err);
                                    failures.push({
                                        lessonTitle: taskTitle,
                                        lessonUrl: lesson.url,
                                        lessonDir,
                                        kind: 'video',
                                        reason: videoError,
                                        videoUrl: lessonData.videoLink
                                    });
                                    taskError = new Error(`Video failed: ${videoError}`);
                                    logger.warn(`    ⚠️ Failed to download video for ${lesson.title}: ${videoError}`);
                                }
                            }

                            const resourcesHtml: string[] = [];
                            if (lessonData.resources && lessonData.resources.length > 0) {
                                const resourcesDir = path.join(lessonDir, 'resources');
                                await fs.ensureDir(resourcesDir);

                                const resTasks = lessonData.resources.map(async (res) => {
                                    if (!res.downloadUrl) return null;

                                    if (res.isExternal) {
                                        logger.info(`    🔗 External resource linked: ${res.title}`);
                                        return `<li><a href="${res.downloadUrl}" target="_blank">${res.title} (External)</a></li>`;
                                    }

                                    try {
                                        updateStatus('Downloading resources...');
                                        const safeFileName = sanitizeName(res.file_name || res.title);
                                        const resPath = path.join(resourcesDir, safeFileName);

                                        if (fs.existsSync(resPath)) {
                                            const stats = fs.statSync(resPath);
                                            if (stats.size > 0) {
                                                logger.info(`    ⏭️  Resource already exists, skipping: ${res.title}`);
                                                return `<li><a href="resources/${encodeURIComponent(safeFileName)}" target="_blank">${res.title}</a></li>`;
                                            }
                                        }

                                        logger.info(`    ⬇️  Downloading resource: ${res.title}`);
                                        await downloader.downloadAsset(res.downloadUrl, resPath);
                                        return `<li><a href="resources/${encodeURIComponent(safeFileName)}" target="_blank">${res.title}</a></li>`;
                                    } catch (err) {
                                        logger.warn(`    ⚠️  Failed to download resource ${res.title}: ${String(err)}`);
                                        return null;
                                    }
                                });

                                const results = await Promise.all(resTasks);
                                results.forEach(r => { if (r) resourcesHtml.push(r); });
                            }

                            const savedPosts: SavedLinkedPost[] = [];
                            for (const post of lessonData.linkedPosts ?? []) {
                                updateStatus(`Saving community post ${savedPosts.length + 1}/${lessonData.linkedPosts!.length}...`);
                                const saved = await saveLinkedPost(post, {
                                    lessonDir,
                                    lessonTitle: lessonData.title,
                                    downloader,
                                    logger,
                                    skipVideos: Boolean(options.skipVideos),
                                    linkResolver
                                });
                                for (const failure of saved.videoFailures) {
                                    failures.push({
                                        lessonTitle: taskTitle,
                                        lessonUrl: lesson.url,
                                        lessonDir,
                                        kind: 'video',
                                        reason: `Video of community post ${post.url}: ${failure.reason}`,
                                        videoUrl: failure.videoUrl
                                    });
                                }
                                if (saved.videoFailures.length > 0 && !taskError) {
                                    taskError = new Error(`${saved.videoFailures.length} video(s) of community post ${post.url} failed`);
                                }
                                savedPosts.push(saved);
                            }
                            const linkedPostsHtml = renderLinkedPosts(savedPosts.map(p => p.view));
                            const sourcesHtml = savedPosts.map(p => renderLinkedPostSource(p.view));

                            const isRootLesson = mInfo.moduleDirName.length === 0;
                            const groupLink = isRootLesson ? '../../index.html' : '../../../index.html';
                            const courseLink = isRootLesson ? '../index.html' : '../../index.html';
                            const moduleBreadcrumb = isRootLesson
                                ? ''
                                : `<span>/</span><span>${module.title}</span>`;
                            const courseDirName = path.basename(baseOutputDir);
                            const lessonRelativePath = (mInfo.moduleDirName
                                ? `${mInfo.moduleDirName}/${lessonDirName}/index.html`
                                : `${lessonDirName}/index.html`).replace(/\\/g, '/');
                            const lessonId = `${courseDirName}/${lessonRelativePath}`;

                            const htmlContent = `
                            <!DOCTYPE html>
                            <html>
                            <head>
                                <meta charset="UTF-8">
                                <meta name="viewport" content="width=device-width, initial-scale=1">
                                <title>${lessonData.title}</title>
                                <style>
                                    :root {
                                        --bg: #f6f3ee;
                                        --panel: #ffffff;
                                        --panel-2: #f6f7fb;
                                        --text: #14161d;
                                        --muted: #5b6271;
                                        --accent: #3b82f6;
                                        --ring: rgba(20,22,29,0.08);
                                        --shadow: 0 16px 32px rgba(15, 23, 42, 0.12);
                                    }
                                    * { box-sizing: border-box; }
                                    body {
                                        margin: 0;
                                        font-family: "Space Grotesk", "Manrope", "Segoe UI", sans-serif;
                                        background: linear-gradient(160deg, #fdfdfd 0%, #eff2fb 100%);
                                        color: var(--text);
                                        line-height: 1.7;
                                    }
                                    .page { max-width: 980px; margin: 48px auto 80px; padding: 0 22px; }
                                    .breadcrumb {
                                        font-size: 0.95rem;
                                        color: var(--muted);
                                        margin-bottom: 16px;
                                        display: flex;
                                        flex-wrap: wrap;
                                        gap: 8px;
                                        align-items: center;
                                    }
                                    .breadcrumb a { color: var(--accent); text-decoration: none; font-weight: 600; }
                                    .breadcrumb span { color: var(--muted); }
                                    .container {
                                        background: var(--panel);
                                        padding: 34px;
                                        border-radius: 20px;
                                        border: 1px solid rgba(20,22,29,0.05);
                                        box-shadow:
                                            0 25px 45px rgba(15, 23, 42, 0.18),
                                            0 10px 20px rgba(15, 23, 42, 0.08);
                                    }
                                    h1 { margin: 0 0 16px 0; font-size: clamp(1.8rem, 3vw, 2.6rem); }
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
                                    video {
                                        width: 100%;
                                        border-radius: 14px;
                                        margin: 10px 0 26px;
                                        display: block;
                                        box-shadow: 0 10px 24px rgba(15, 23, 42, 0.2);
                                        background: #000;
                                    }
                                    img { max-width: 100%; border-radius: 10px; height: auto; margin: 14px 0; }
                                    .content { font-size: 1.05rem; }
                                    .content p { margin-bottom: 1.2em; }
                                    .content pre {
                                        background: #1e1e24;
                                        color: #f8f9fa;
                                        border: 1px solid rgba(20,22,29,0.1);
                                        border-radius: 10px;
                                        padding: 16px 20px;
                                        overflow-x: auto;
                                        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
                                        font-size: 0.95rem;
                                        line-height: 1.6;
                                        margin: 18px 0;
                                    }
                                    .content pre code {
                                        background: transparent;
                                        color: inherit;
                                        padding: 0;
                                        border-radius: 0;
                                        font-size: inherit;
                                    }
                                    .content code {
                                        background: rgba(20,22,29,0.06);
                                        color: #d63384;
                                        padding: 2px 6px;
                                        border-radius: 5px;
                                        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
                                        font-size: 0.9em;
                                    }
                                    .content blockquote {
                                        margin: 18px 0;
                                        padding: 12px 20px;
                                        border-left: 4px solid var(--accent);
                                        background: var(--panel-2);
                                        border-radius: 0 10px 10px 0;
                                        color: var(--text);
                                    }
                                    .content hr {
                                        border: none;
                                        border-top: 1px solid rgba(20,22,29,0.1);
                                        margin: 28px 0;
                                    }
                                    .content ul, .content ol {
                                        margin: 14px 0 18px 24px;
                                        padding: 0;
                                    }
                                    .content li {
                                        margin-bottom: 8px;
                                    }
                                    .content table {
                                        width: 100%;
                                        border-collapse: collapse;
                                        margin: 20px 0;
                                    }
                                    .content th, .content td {
                                        border: 1px solid rgba(20,22,29,0.1);
                                        padding: 10px 14px;
                                        text-align: left;
                                    }
                                    .content th {
                                        background: var(--panel-2);
                                        font-weight: 600;
                                    }
                                    .resources {
                                        background: var(--panel-2);
                                        padding: 18px;
                                        border-radius: 14px;
                                        border: 1px solid var(--ring);
                                        margin-top: 28px;
                                    }
                                    .resources h3 { margin: 0 0 10px 0; color: var(--accent); }
                                    .resources ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
                                    .resources a {
                                        color: #1f3d7a;
                                        font-weight: 600;
                                        display: inline-flex;
                                        align-items: center;
                                        gap: 8px;
                                        text-decoration: none;
                                    }
                                    .resources a::before { content: "📁"; }
                                    ${LINKED_POSTS_CSS}
                                    a { color: var(--accent); text-decoration: none; word-break: break-word; }
                                    a:hover { text-decoration: underline; }
                                    .nav { margin-top: 28px; padding-top: 16px; border-top: 1px solid rgba(20,22,29,0.08); }
                                </style>
                            </head>
                            <body>
                                <div class="page">
                                    <div class="breadcrumb">
                                        <a href="${groupLink}">${groupName}</a>
                                        <span>/</span>
                                        <a href="${courseLink}">${courseName}</a>
                                        ${moduleBreadcrumb}
                                        <span>/</span>
                                        <span>${lessonData.title}</span>
                                    </div>
                                    <div class="container">
                                        <h1>${lessonData.title} <button type="button" class="lesson-title-tick" id="lessonTickBtn" data-lesson-id="${lessonId}" title="Marcar como realizada" aria-label="Marcar como realizada"><svg viewBox="0 0 20 20" fill="none"><path d="M4.5 10.5L8 14L15.5 5.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button></h1>
                                        ${hasVideo ? '<video controls src="video.mp4"></video>' : ''}
                                        <div class="content">
                                            ${localizedHtml}
                                        </div>
                                        ${resourcesHtml.length + sourcesHtml.length > 0 ? `
                                        <div class="resources">
                                            <h3>Resources / Attachments</h3>
                                            <ul>
                                                ${resourcesHtml.join('')}${sourcesHtml.join('')}
                                            </ul>
                                        </div>
                                        ` : ''}
                                        ${linkedPostsHtml}
                                        <div class="nav">
                                            <a href="${courseLink}">Back to Course Index</a>
                                        </div>
                                    </div>
                                </div>
                                ${renderLessonProgressScript()}
                            </body>
                            </html>
                        `;

                            await fs.writeFile(path.join(lessonDir, 'index.html'), htmlContent);

                            updateStatus('Saving metadata...');
                            const lessonManifest: LessonManifest = {
                                lessonId: lesson.id,
                                title: lesson.title,
                                moduleIndex: mInfo.mIndex,
                                moduleTitle: mInfo.title,
                                lessonIndex: lIndex,
                                moduleDirName: mInfo.moduleDirName,
                                lessonDirName,
                                relativePath: mInfo.moduleDirName
                                    ? `${mInfo.moduleDirName}/${lessonDirName}/index.html`
                                    : `${lessonDirName}/index.html`,
                                hasVideo,
                                videoError,
                                ...(videoSkipped ? { videoSkipped, videoSource } : {}),
                                resourcesCount: resourcesHtml.length,
                                ...(savedPosts.length > 0 ? { linkedPosts: savedPosts.map(p => p.manifest) } : {}),
                                updatedAt: new Date().toISOString()
                            };

                            await writeAtomicJson(path.join(lessonDir, 'lesson.json'), lessonManifest);

                            completedLessons += 1;
                            options.callbacks?.onLessonComplete?.({
                                moduleIndex: mInfo.mIndex,
                                lessonIndex: lIndex,
                                lessonTitle: lesson.title,
                                hasVideo,
                                resourcesCount: resourcesHtml.length
                            });

                            updateStatus('Updating course index...');
                            indexLimit(() => regenerateIndex(baseOutputDir, { silent: options.suppressIndexLogs, patchLessons: false }));
                        } catch (err) {
                            failedLessons += 1;
                            failures.push({
                                lessonTitle: taskTitle,
                                lessonUrl: lesson.url,
                                lessonDir,
                                kind: 'lesson',
                                reason: String(err)
                            });
                            taskError = err instanceof Error ? err : new Error(String(err));
                            options.callbacks?.onLessonError?.({
                                moduleIndex: mInfo.mIndex,
                                lessonIndex: lIndex,
                                lessonTitle: lesson.title,
                                error: err
                            });
                            logger.error(`    ⚠️ Error processing lesson ${lesson.title}: ${String(err)}`);
                        }
                        if (taskError) throw taskError;
                    }
                });
            }
        }

        if (options.runTasks) {
            await options.runTasks(tasks, concurrency);
        } else {
            await runConcurrent(tasks.map(task => () => task.run()), concurrency);
        }
        await indexLimit(() => regenerateIndex(baseOutputDir, { silent: options.suppressIndexLogs }));
        await groupIndexLimit(() => regenerateGroupIndex(activeGroupDir ?? path.dirname(baseOutputDir), { silent: options.suppressIndexLogs }));

        const summary: DownloadSummary = {
            courseName,
            groupName,
            outputDir: baseOutputDir,
            modulesCount: modules.length,
            lessonsCount: totalLessons,
            completedLessons,
            failedLessons,
            failedVideos: failures.filter(f => f.kind === 'video').length,
            failures,
            targetLessonId
        };

        // Kept next to the course so a rerun (which retries exactly these) and
        // the person reading the output both know what is missing.
        const failuresPath = path.join(baseOutputDir, '.download-failures.json');
        if (failures.length > 0) {
            await writeAtomicJson(failuresPath, { updatedAt: new Date().toISOString(), failures });
        } else if (!targetLessonId) {
            await fs.remove(failuresPath);
        }

        options.callbacks?.onCourseComplete?.(summary);

        if (failures.length > 0) {
            logger.warn(`\n⚠️ ${courseName}: ${summary.failedLessons} lessons and ${summary.failedVideos} videos failed (see .download-failures.json). Rerun to retry them.`);
        } else {
            logger.info('\n✨ All downloads complete!');
        }
        logger.info(`Check your files in: ${baseOutputDir}`);

        return summary;
    } finally {
        await scraper.close();
    }
}
