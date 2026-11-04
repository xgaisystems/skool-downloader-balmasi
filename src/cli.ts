import { intro, outro, select, text, confirm, spinner, isCancel, cancel, log, multiselect } from '@clack/prompts';
import pc from 'picocolors';
import path from 'path';
import fs from 'fs-extra';
import { Listr, PRESET_TIMER } from 'listr2';
import cliTruncate from 'cli-truncate';
import stringWidth from 'string-width';
import logUpdate from 'log-update';
import cliCursor from 'cli-cursor';
import { downloadCourse, type DownloadMode, type DownloadSummary } from './index.js';
import { login, getAuthStatus } from './auth.js';
import { regenerateIndex } from './regenerate-index.js';
import { updateYtDlp, rollbackYtDlp, getYtDlpPaths, findFfmpegCandidates, installBundledFfmpeg, FFMPEG_INSTALL_HINT } from './downloader.js';
import { regenerateGroupIndex } from './regenerate-group-index.js';
import { Scraper, type CourseLibraryResult, type CourseListItem } from './scraper.js';
import type { Logger } from './logger.js';
import { formatDateTime } from './utils.js';
import { startServer } from './server.js';
import { PROGRESS_SERVER_PORT } from './progress-sync.js';

type CliArgs = {
    command?: 'login' | 'download' | 'regenerate-index' | 'update' | 'serve' | 'help';
    url?: string;
    outputDir?: string;
    concurrency?: number;
    mode?: DownloadMode;
    lessonId?: string | null;
    regenerateDir?: string;
    rollback?: boolean;
    port?: number;
    host?: string;
    skipVideos?: boolean;
};

function showHelp() {
    console.log(`\nSkool Downloader\n\nUsage:\n  skool                          Interactive mode\n  skool login                    Log in to Skool\n  skool <classroom-url>          Download a course\n  skool <group-classroom-url>    Download all courses in a community\n  skool <lesson-url>             Download a single lesson (URL with ?md=)\n  skool regenerate-index         Regenerate all course indexes\n  skool update                   Update the yt-dlp binary to the latest release\n  skool serve [port]             Start local web server with real-time progress sync\n\nOptions:\n  -o, --output <dir>             Output directory (course root)\n  -c, --concurrency <number>     Lesson concurrency (default: 8)\n  -p, --port <number>            Port for local web server (default: 3100)\n  --host <address>               Address the server listens on (default: 127.0.0.1; 0.0.0.0 opens it to your network)\n  --course                       Force course mode (ignore ?md=)\n  --lesson                       Force lesson mode\n  --lesson-id <id>               Explicit lesson id\n  --no-videos                    Save lessons without downloading their videos\n  --rollback                     With 'update', restore the previous yt-dlp\n  -h, --help                     Show help\n\nEnvironment:\n  SKOOL_DOWNLOADER_CACHE_DIR     Where the yt-dlp binary is kept\n  SKOOL_NO_YTDLP_UPDATE=1        Never check for a newer yt-dlp automatically\n`);
}

function parseArgs(args: string[]): CliArgs {
    const parsed: CliArgs = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === 'login') {
            parsed.command = 'login';
            continue;
        }
        if (arg === 'regenerate-index') {
            parsed.command = 'regenerate-index';
            parsed.regenerateDir = args[i + 1];
            continue;
        }
        if (arg === 'update') {
            parsed.command = 'update';
            continue;
        }
        if (arg === 'serve') {
            parsed.command = 'serve';
            const next = args[i + 1];
            if (next && /^\d+$/.test(next)) {
                parsed.port = Number.parseInt(next, 10);
                i++;
            }
            continue;
        }
        if (arg === '--host') {
            const next = args[i + 1];
            if (next) {
                parsed.host = next;
                i++;
            }
            continue;
        }
        if (arg === '-p' || arg === '--port') {
            const next = args[i + 1];
            if (next && /^\d+$/.test(next)) {
                parsed.port = Number.parseInt(next, 10);
                i++;
            }
            continue;
        }
        if (arg === '--no-videos' || arg === '--skip-videos') {
            parsed.skipVideos = true;
            continue;
        }
        if (arg === '--rollback') {
            parsed.rollback = true;
            continue;
        }
        if (arg === '-h' || arg === '--help') {
            parsed.command = 'help';
            continue;
        }
        if (arg === '--course') {
            parsed.mode = 'course';
            continue;
        }
        if (arg === '--lesson') {
            parsed.mode = 'lesson';
            continue;
        }
        if (arg === '--lesson-id') {
            parsed.lessonId = args[i + 1];
            i++;
            continue;
        }
        if (arg === '-o' || arg === '--output') {
            parsed.outputDir = args[i + 1];
            i++;
            continue;
        }
        if (arg === '-c' || arg === '--concurrency') {
            const next = args[i + 1];
            parsed.concurrency = next ? Number.parseInt(next, 10) : undefined;
            i++;
            continue;
        }
        if (!parsed.url && arg.startsWith('http')) {
            parsed.url = arg;
            parsed.command = 'download';
            continue;
        }
    }

    return parsed;
}

function handleCancel(value: unknown) {
    if (isCancel(value)) {
        cancel('Operation cancelled.');
        process.exit(0);
    }
}

// While a task renderer owns the screen it redraws over anything else written
// to the terminal, so warnings printed mid-run were erased. They are queued
// here and printed once the renderer is done.
let deferredLogs: Array<() => void> | null = null;

function emitLog(write: () => void) {
    if (deferredLogs) deferredLogs.push(write);
    else write();
}

function buildInteractiveLogger(): Logger {
    return {
        info: () => {},
        debug: () => {},
        warn: (message) => emitLog(() => log.warn(message)),
        error: (message, error) => {
            const text = error ? `${message} ${String(error)}` : message;
            emitLog(() => log.error(text));
        }
    };
}

function reportCourseFailures(summary: DownloadSummary) {
    if (summary.failures.length === 0) return;
    log.warn(pc.yellow(`${summary.courseName}: ${summary.failedLessons} lessons and ${summary.failedVideos} videos failed. Rerun to retry them.`));
    for (const failure of summary.failures) {
        const what = failure.kind === 'video' ? 'video' : 'lesson';
        log.warn(`  ✖ ${failure.lessonTitle} (${what}): ${failure.reason}`);
    }
    log.warn(pc.dim(`List saved to ${path.join(summary.outputDir, '.download-failures.json')}`));
}

function formatExpiry(expiresAt?: Date) {
    if (!expiresAt) return 'unknown time';
    return formatDateTime(expiresAt);
}

function sanitizeName(value: string) {
    // Windows drops trailing dots and spaces from folder names, so "Title..." would not resolve.
    return value.replace(/[/\\?%*:|"<>]/g, '-').replace(/[. ]+$/, '');
}

function isClassroomRootUrl(value: string) {
    try {
        const url = new URL(value);
        const parts = url.pathname.split('/').filter(Boolean);
        const classroomIndex = parts.indexOf('classroom');
        return classroomIndex !== -1 && classroomIndex === parts.length - 1;
    } catch {
        return false;
    }
}

/**
 * Every video download needs ffmpeg, and without one each lesson fails on its
 * own, so check before starting. With nothing usable, offer to fetch the
 * bundled build: npm 12+ skips its install script unless package.json allows
 * it, and the install also fails offline or behind a proxy.
 */
async function ensureFfmpeg(): Promise<boolean> {
    if ((await findFfmpegCandidates()).length > 0) return true;

    log.warn('No working ffmpeg was found. It is needed to merge the video and audio of most videos.');

    if (!process.stdin.isTTY) {
        console.error(`${FFMPEG_INSTALL_HINT}\nOr run "skool" in a terminal, which offers to download it.`);
        return false;
    }

    const shouldDownload = await confirm({
        message: 'Download ffmpeg now? (about 80 MB, the build for this system from the ffmpeg-static project)'
    });
    handleCancel(shouldDownload);

    if (shouldDownload) {
        const downloadSpinner = spinner();
        downloadSpinner.start('Downloading ffmpeg...');
        try {
            const installed = await installBundledFfmpeg();
            downloadSpinner.stop(`ffmpeg ready: ${installed}`);
            log.info(pc.dim('A system ffmpeg (brew, winget or apt) is newer than this one and is used first once installed.'));
            return true;
        } catch (err) {
            downloadSpinner.stop('Could not download ffmpeg.');
            log.error(err instanceof Error ? err.message : String(err));
        }
    }

    log.info(FFMPEG_INSTALL_HINT);
    return false;
}

async function ensureLogin(): Promise<boolean> {
    const status = await getAuthStatus();
    if (status.status === 'valid') {
        if (status.expiresAt) {
            log.info(`Using saved login (expires ${formatExpiry(status.expiresAt)}).`);
        } else {
            log.info('Using saved login.');
        }
        return true;
    }

    let promptMessage = 'No saved login session found. Open a browser to log in now?';
    if (status.status === 'expired') {
        promptMessage = `Saved login expired on ${formatExpiry(status.expiresAt)}. Log in again now?`;
    } else if (status.status === 'no-expiry') {
        promptMessage = 'Saved login has no expiry info. Log in again now?';
    } else if (status.status === 'invalid') {
        promptMessage = 'Saved login could not be validated. Log in again now?';
    }

    const shouldLogin = await confirm({ message: promptMessage, initialValue: true });
    handleCancel(shouldLogin);

    if (shouldLogin) {
        await login();
        return true;
    }

    log.warn('Login required to continue.');
    return false;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function padRight(str: string, targetWidth: number): string {
    const truncated = cliTruncate(str, targetWidth);
    const visibleWidth = stringWidth(truncated);
    const pad = Math.max(0, targetWidth - visibleWidth);
    return truncated + ' '.repeat(pad);
}

function formatDuration(sec: number): string {
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}m ${s}s`;
}

async function runMultiColumnTasks(
    tasks: { title: string; run: (onStatus?: (message: string) => void) => Promise<void> }[],
    concurrency: number
): Promise<void> {
    cliCursor.hide();

    // Only stops drawing. Exiting here would beat the handler in index.ts,
    // which saves the course index before it exits the process.
    const onSigInt = () => {
        isDone = true;
        clearInterval(timer);
        logUpdate.done();
        cliCursor.show();
    };
    process.once('SIGINT', onSigInt);

    let termRows = process.stdout.rows || 50;
    let termCols = process.stdout.columns || 140;

    const onResize = () => {
        termRows = process.stdout.rows || 50;
        termCols = process.stdout.columns || 140;
    };
    process.stdout.on('resize', onResize);

    const taskStates = tasks.map((t) => ({
        title: t.title,
        status: '',
        state: 'pending' as 'pending' | 'running' | 'completed' | 'failed',
        startTime: 0,
        duration: ''
    }));

    const startTime = Date.now();
    let spinnerIdx = 0;
    let isDone = false;

    const render = () => {
        if (isDone) return;
        spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;
        const spinnerIcon = pc.cyan(SPINNER_FRAMES[spinnerIdx]);

        const completed = taskStates.filter((t) => t.state === 'completed').length;
        const failed = taskStates.filter((t) => t.state === 'failed').length;
        const running = taskStates.filter((t) => t.state === 'running').length;
        const total = tasks.length;
        const percent = Math.floor((completed / total) * 100);
        const elapsed = formatDuration((Date.now() - startTime) / 1000);

        const barWidth = 20;
        const filled = Math.round((completed / total) * barWidth);
        const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

        const header = `${pc.bold(pc.cyan('Progreso:'))} [${pc.green(bar)}] ${pc.bold(`${completed}/${total}`)} (${percent}%) · ${pc.yellow(`${running} activas`)} · ${pc.green(`${completed} completadas`)}${failed > 0 ? ` · ${pc.red(`${failed} fallos`)}` : ''} · ${pc.dim(elapsed)}`;
        const divider = pc.dim('─'.repeat(Math.min(termCols, 120)));

        const headerLines = 2;
        const maxGridRows = Math.max(8, termRows - headerLines - 2);

        const minColWidth = 32;
        const maxColsByWidth = Math.max(1, Math.floor((termCols - 2) / minColWidth));
        const neededCols = Math.ceil(total / maxGridRows);
        const numCols = Math.min(neededCols, maxColsByWidth);
        const rowsPerCol = Math.ceil(total / numCols);
        const colWidth = Math.max(20, Math.floor((termCols - (numCols - 1) * 3) / numCols));

        const lines = [header, divider];

        for (let r = 0; r < rowsPerCol; r++) {
            const rowItems: string[] = [];
            for (let c = 0; c < numCols; c++) {
                const idx = c * rowsPerCol + r;
                if (idx < total) {
                    const t = taskStates[idx];
                    let cell = '';
                    if (t.state === 'completed') {
                        cell = `${pc.green('✔')} ${t.title} ${pc.dim(t.duration ? `(${t.duration})` : '')}`;
                    } else if (t.state === 'running') {
                        cell = `${spinnerIcon} ${t.title} ${t.status ? pc.yellow(t.status) : ''}`;
                    } else if (t.state === 'failed') {
                        cell = `${pc.red('✖')} ${t.title} ${pc.red(t.status || 'error')}`;
                    } else {
                        cell = `${pc.dim('·')} ${pc.dim(t.title)}`;
                    }
                    rowItems.push(padRight(cell, colWidth));
                } else {
                    rowItems.push(' '.repeat(colWidth));
                }
            }
            lines.push(rowItems.join(pc.dim(' │ ')));
        }

        logUpdate(lines.join('\n'));
    };

    const timer = setInterval(render, 80);

    let nextIndex = 0;
    const workerCount = Math.min(concurrency, tasks.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const current = nextIndex;
            nextIndex += 1;
            if (current >= tasks.length) return;

            const item = taskStates[current];
            item.state = 'running';
            item.startTime = Date.now();
            item.status = 'Iniciando...';

            try {
                await tasks[current].run((msg) => {
                    if (msg) item.status = msg;
                });
                item.state = 'completed';
                item.duration = formatDuration((Date.now() - item.startTime) / 1000);
            } catch (err) {
                item.state = 'failed';
                item.status = String(err);
            }
        }
    });

    try {
        await Promise.all(workers);
    } finally {
        isDone = true;
        clearInterval(timer);
        process.stdout.off('resize', onResize);
        process.off('SIGINT', onSigInt);
        render();
        logUpdate.done();
        cliCursor.show();
        process.stdout.write('\n');
    }
}

function createTaskRunner() {
    const runTasks = createRenderedTaskRunner();
    return async (tasks: { title: string; run: (onStatus?: (message: string) => void) => Promise<void> }[], concurrency: number) => {
        deferredLogs = [];
        const flushDeferredLogs = () => {
            const queued = deferredLogs ?? [];
            deferredLogs = null;
            queued.forEach(write => write());
        };
        // Registered after downloadCourse's own handler, so its "saving the
        // index" warning is already queued and shows before the process exits.
        process.once('SIGINT', flushDeferredLogs);
        try {
            await runTasks(tasks, concurrency);
        } finally {
            process.off('SIGINT', flushDeferredLogs);
            flushDeferredLogs();
        }
    };
}

function createRenderedTaskRunner() {
    return async (tasks: { title: string; run: (onStatus?: (message: string) => void) => Promise<void> }[], concurrency: number) => {
        const termRows = process.stdout.rows || 40;
        const availableRows = Math.max(10, termRows - 4);

        if (tasks.length <= availableRows) {
            const list = new Listr(
                tasks.map((entry) => ({
                    title: entry.title,
                    task: async (_ctx, task) => {
                        task.output = 'Starting...';
                        await entry.run((message) => {
                            if (message) task.output = message;
                        });
                    }
                })),
                {
                    concurrent: concurrency,
                    exitOnError: false,
                    // Listr's own handler calls process.exit(127) on Ctrl+C,
                    // which killed the index save in index.ts before it ran.
                    registerSignalListeners: false,
                    rendererOptions: {
                        timer: PRESET_TIMER,
                        collapseErrors: false,
                        collapseSubtasks: false
                    }
                }
            );

            // Ends the renderer the way Listr's own signal handler would, minus
            // the exit. The renderer is private, hence the cast.
            const onSigInt = () => (list as any).renderer?.end(new Error('Interrupted.'));
            process.once('SIGINT', onSigInt);

            // run() tears the renderer down itself, so there is nothing to end here.
            try {
                await list.run();
            } finally {
                process.off('SIGINT', onSigInt);
            }
            process.stdout.write('\n');
            await new Promise(resolve => setTimeout(resolve, 0));
            return;
        }

        await runMultiColumnTasks(tasks, concurrency);
    };
}

async function fetchCourseLibrary(url: string, logger: Logger): Promise<CourseLibraryResult> {
    const scraper = new Scraper(logger);
    try {
        return await scraper.parseCourseLibrary(url);
    } finally {
        await scraper.close();
    }
}

function buildCourseHint(course: CourseListItem) {
    const parts: string[] = [];
    if (course.numModules) {
        parts.push(`${course.numModules} modules`);
    }
    if (course.hasAccess === false) {
        parts.push('locked');
    }
    if (course.privacy === 1) {
        parts.push('private');
    }
    return parts.length > 0 ? parts.join(' · ') : undefined;
}

function filterAccessibleCourses(courses: CourseListItem[]) {
    // hasAccess is the answer for this account. privacy only says the course is
    // gated (e.g. by level or purchase), and members who unlocked it still see
    // privacy 1, so it is a fallback for when Skool leaves hasAccess out.
    const isLocked = (course: CourseListItem) =>
        course.hasAccess === undefined ? (course.privacy ?? 0) > 0 : !course.hasAccess;
    const accessible = courses.filter(course => !isLocked(course));
    const locked = courses.filter(course => isLocked(course));
    return { accessible, locked };
}

function resolveCourseOutputDir(outputRoot: string, groupName: string, courseName: string) {
    return path.join(outputRoot, sanitizeName(groupName), sanitizeName(courseName));
}

async function runInteractive() {
    intro(pc.cyan('Skool Downloader'));

    const action = await select({
        message: 'What would you like to do?',
        options: [
            { value: 'download-course', label: 'Download a full course' },
            { value: 'download-multi', label: 'Download multiple courses' },
            { value: 'download-lesson', label: 'Download a single lesson' },
            { value: 'serve', label: 'Start local server (serve offline courses with live sync)' },
            { value: 'regenerate-index', label: 'Regenerate all course indexes' },
            { value: 'login', label: 'Log in to Skool' },
            { value: 'update', label: 'Update the yt-dlp binary' },
            { value: 'exit', label: 'Exit' }
        ]
    });
    handleCancel(action);
    const actionValue = action as 'download-course' | 'download-multi' | 'download-lesson' | 'serve' | 'login' | 'regenerate-index' | 'update' | 'exit';

    if (actionValue === 'exit') {
        outro('See you next time.');
        return;
    }

    if (actionValue === 'serve') {
        await runServe();
        return;
    }

    if (actionValue === 'login') {
        const loginSpinner = spinner();
        loginSpinner.start('Opening login browser...');
        await login();
        loginSpinner.stop('Login saved.');
        outro('Session ready for downloads.');
        return;
    }

    if (actionValue === 'regenerate-index') {
        await regenerateAllIndexes();
        outro('Indexes regenerated.');
        return;
    }

    if (actionValue === 'update') {
        await runYtDlpUpdate(false);
        outro('yt-dlp check finished.');
        return;
    }

    const loggedIn = await ensureLogin();
    if (!loggedIn) {
        outro('Login required. Exiting.');
        return;
    }

    const downloadVideos = await confirm({
        message: 'Download videos?',
        initialValue: true
    });
    handleCancel(downloadVideos);
    const skipVideos = !downloadVideos;

    if (!skipVideos && !await ensureFfmpeg()) {
        outro('ffmpeg is required for video downloads. Exiting.');
        return;
    }

    let concurrency = 8;
    if (actionValue === 'download-course' || actionValue === 'download-multi') {
        const concurrencyChoice = await select({
            message: 'Lesson concurrency',
            options: [
                { value: 2, label: '2 (gentle)' },
                { value: 4, label: '4 (steady)' },
                { value: 8, label: '8 (fast)' },
                { value: 12, label: '12 (very fast)' }
            ],
            initialValue: 8
        });
        handleCancel(concurrencyChoice);
        concurrency = Number(concurrencyChoice);
    }

    const interactiveLogger = buildInteractiveLogger();
    const runTasks = createTaskRunner();

    if (actionValue === 'download-multi') {
        const urlInput = await text({
            message: 'Community classroom URL',
            placeholder: 'https://www.skool.com/community/classroom',
            validate(value) {
                if (!value || !value.startsWith('http')) return 'Please enter a valid URL.';
                return undefined;
            }
        });
        handleCancel(urlInput);
        const url = String(urlInput);

        const outputDir = await text({
            message: 'Custom output directory (leave empty for default downloads/)',
            placeholder: path.join(process.cwd(), 'downloads')
        });
        handleCancel(outputDir);
        const outputDirValue = typeof outputDir === 'string' ? outputDir.trim() : '';
        const outputRoot = outputDirValue.length > 0 ? outputDirValue : undefined;

        const librarySpinner = spinner();
        librarySpinner.start('Fetching courses...');
        let library: CourseLibraryResult;
        try {
            library = await fetchCourseLibrary(url, interactiveLogger);
            librarySpinner.stop(`Found ${library.courses.length} courses.`);
        } catch (err) {
            librarySpinner.stop('Failed to fetch courses.');
            log.error(`Unable to load course list: ${String(err)}`);
            outro('Could not fetch courses.');
            return;
        }

        const { accessible, locked } = filterAccessibleCourses(library.courses);
        if (accessible.length === 0) {
            log.warn('No accessible courses found to download.');
            outro('Nothing to download.');
            return;
        }

        if (locked.length > 0) {
            log.warn(`Locked courses (no access):`);
            for (const course of locked) {
                log.warn(`  🔒 ${course.title}`);
            }
        }

        const courseOptions = accessible.map(course => ({
            value: course.key,
            label: course.title,
            hint: buildCourseHint(course)
        }));

        const accessibleKeys = new Set(accessible.map(course => course.key));

        const selection = await multiselect({
            message: 'Select courses to download',
            options: courseOptions,
            initialValues: courseOptions.map(option => option.value).filter(key => accessibleKeys.has(key))
        });
        handleCancel(selection);

        const selectedKeys = new Set(selection as string[]);
        const selectedCourses = accessible.filter(course => selectedKeys.has(course.key));

        if (selectedCourses.length === 0) {
            log.warn('No courses selected.');
            outro('Nothing to download.');
            return;
        }

        let failedCourses = 0;
        let totalFailures = 0;

        for (const course of selectedCourses) {
            log.info(`\n${pc.bold(course.title)} ${pc.dim(`· ${library.groupName}`)}`);
            try {
                const summary = await downloadCourse({
                    url: course.url,
                    outputDir: outputRoot ? resolveCourseOutputDir(outputRoot, library.groupName, course.title) : undefined,
                    concurrency,
                    mode: 'course',
                    skipVideos,
                    logger: interactiveLogger,
                    suppressIndexLogs: true,
                    runTasks,
                    callbacks: {
                        onCourseStart: ({ modulesCount, lessonsCount, outputDir: resolvedDir }) => {
                            log.info(`${modulesCount} modules · ${lessonsCount} lessons`);
                            log.info(`Course will save to: ${resolvedDir}`);
                        }
                    }
                });

                reportCourseFailures(summary);
                totalFailures += summary.failures.length;
            } catch (err) {
                failedCourses += 1;
                log.error(`Failed to download course ${course.title}: ${String(err)}`);
            }
        }

        if (failedCourses > 0) {
            log.warn(`${failedCourses} courses failed. You can rerun to fill gaps.`);
        }

        outro(failedCourses > 0 || totalFailures > 0
            ? `Selected courses processed with ${failedCourses} failed courses and ${totalFailures} failed lessons/videos.`
            : 'All selected courses processed.');
        return;
    }

    const urlInput = await text({
        message: actionValue === 'download-course' ? 'Course classroom URL' : 'Lesson URL (with ?md=...)',
        placeholder: 'https://www.skool.com/community/classroom/abcdef',
        validate(value) {
            if (!value || !value.startsWith('http')) return 'Please enter a valid URL.';
            return undefined;
        }
    });
    handleCancel(urlInput);
    const url = String(urlInput);

    const outputDir = await text({
        message: 'Custom output directory (leave empty for default)',
        placeholder: path.join(process.cwd(), 'downloads')
    });
    handleCancel(outputDir);

    const lessonId: string | null = null;
    const outputDirValue = typeof outputDir === 'string' ? outputDir.trim() : '';

    const summary = await downloadCourse({
        url: url.trim(),
        outputDir: outputDirValue.length > 0 ? outputDirValue : undefined,
        concurrency: actionValue === 'download-lesson' ? 1 : concurrency,
        mode: actionValue === 'download-lesson' ? 'lesson' : 'course',
        lessonId,
        skipVideos,
        logger: interactiveLogger,
        suppressIndexLogs: true,
        runTasks,
        callbacks: {
            onCourseStart: ({ courseName, groupName, modulesCount, lessonsCount, outputDir: resolvedDir, targetLessonId, lessonDestination }) => {
                log.info(`${pc.bold(courseName)} ${groupName ? pc.dim(`· ${groupName}`) : ''}`);
                log.info(`${modulesCount} modules · ${lessonsCount} lessons`);
                if (targetLessonId) {
                    log.info(`Single lesson id: ${targetLessonId}`);
                }
                log.info(`Course will save to: ${resolvedDir}`);
                if (lessonDestination) {
                    log.info(`Lesson folder: ${lessonDestination.lessonOutputDir}`);
                    log.info(`Lesson page: ${path.join(lessonDestination.lessonOutputDir, 'index.html')}`);
                    log.info('Lesson assets: video.mp4 (if present) and resources/ folder');
                }
            }
        }
    });

    reportCourseFailures(summary);

    outro(summary.failures.length > 0 ? 'Finished with failures.' : 'All set!');
    console.log(`Files are ready at:\n${summary.outputDir}`);
}

/**
 * Manual escape hatch for the automatic staleness check. Needed when the check
 * is switched off, when it could not reach GitHub, or when a new yt-dlp
 * release broke something that used to work.
 */
async function runYtDlpUpdate(rollback: boolean) {
    const paths = getYtDlpPaths();

    if (rollback) {
        try {
            const result = await rollbackYtDlp();
            const from = result.from ? `${result.from} ` : '';
            console.log(`\u2705 Restored yt-dlp ${from}to ${result.to}`);
        } catch (error) {
            console.error(`\u274c Could not roll back: ${String(error)}`);
            process.exitCode = 1;
        }
        return;
    }

    console.log(`Checking for a newer yt-dlp in ${paths.binDir} ...`);
    try {
        const result = await updateYtDlp();
        if (!result.changed) {
            console.log(`\u2705 yt-dlp ${result.to} is already the latest release.`);
            return;
        }
        if (result.from === null) {
            console.log(`\u2705 Installed yt-dlp ${result.to}`);
            return;
        }
        console.log(`\u2705 Updated yt-dlp from ${result.from} to ${result.to}`);
        console.log(`   The previous copy is kept at ${paths.previousPath}`);
        console.log('   Run `skool update --rollback` if the new one behaves worse.');
    } catch (error) {
        console.error(`\u274c Could not update yt-dlp: ${String(error)}`);
        process.exitCode = 1;
    }
}

async function regenerateAllIndexes() {
    const downloadsRoot = path.join(process.cwd(), 'downloads');
    const rootExists = await fs.pathExists(downloadsRoot);
    if (!rootExists) {
        console.log(`Downloads folder not found: ${downloadsRoot}`);
        return;
    }

    const groupEntries = await fs.readdir(downloadsRoot, { withFileTypes: true });
    const groupDirs = groupEntries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

    if (groupDirs.length === 0) {
        console.log('No group folders found to regenerate.');
        return;
    }

    let regeneratedCourses = 0;
    let regeneratedGroups = 0;

    for (const groupDir of groupDirs) {
        const groupPath = path.join(downloadsRoot, groupDir.name);
        const courseEntries = await fs.readdir(groupPath, { withFileTypes: true });
        const courseDirs = courseEntries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

        if (courseDirs.length === 0) continue;

        for (const courseDir of courseDirs) {
            const coursePath = path.join(groupPath, courseDir.name);
            await regenerateIndex(coursePath, { silent: true });
            regeneratedCourses += 1;
        }

        await regenerateGroupIndex(groupPath, { silent: true });
        regeneratedGroups += 1;
    }

    console.log(`Regenerated ${regeneratedCourses} course indexes across ${regeneratedGroups} groups.`);
}

async function runServe(port?: number, host?: string) {
    const downloadsDir = path.join(process.cwd(), 'downloads');
    if (!fs.existsSync(downloadsDir)) {
        await fs.mkdirp(downloadsDir);
    }

    const listenHost = host || '127.0.0.1';
    const { start } = startServer({
        port: port || PROGRESS_SERVER_PORT,
        host: listenHost,
        rootDir: downloadsDir,
        onReady: (info) => {
            console.log('');
            console.log(pc.bold(pc.green('🚀 Skool Downloader local server is running')));
            console.log(`   ${pc.bold('Communities:')} ${pc.underline(pc.cyan(info.url))}`);
            console.log(`   ${pc.bold('Serving:')}     ${downloadsDir}`);
            console.log(`   ${pc.bold('Progress:')}    ${path.join(downloadsDir, 'progress.json')} (synced live across tabs and devices)`);
            if (listenHost === '127.0.0.1' || listenHost === 'localhost') {
                console.log(pc.dim('   Only this computer can connect. Use --host 0.0.0.0 to open it to your network.'));
            } else {
                console.log(pc.yellow(`   Listening on ${listenHost}: anyone on your network can see the courses and change progress.`));
            }
            if (info.port !== PROGRESS_SERVER_PORT) {
                console.log(pc.yellow(`   Pages opened as file:// only sync with port ${PROGRESS_SERVER_PORT}; open them through this server instead.`));
            }
            console.log(pc.dim('   Press Ctrl+C to stop.'));
            console.log('');
        }
    });

    try {
        await start();
    } catch (err) {
        console.error(pc.red(String(err instanceof Error ? err.message : err)));
        process.exitCode = 1;
        return;
    }
    await new Promise(() => {});
}

async function runWithArgs(args: CliArgs) {
    if (args.command === 'help') {
        showHelp();
        return;
    }

    if (args.command === 'serve') {
        await runServe(args.port, args.host);
        return;
    }

    if (args.command === 'login') {
        await login();
        return;
    }

    if (args.command === 'update') {
        await runYtDlpUpdate(Boolean(args.rollback));
        return;
    }

    if (args.command === 'regenerate-index') {
        if (!args.regenerateDir) {
            await regenerateAllIndexes();
            return;
        }

        await regenerateIndex(args.regenerateDir);
        await regenerateGroupIndex(path.dirname(args.regenerateDir));
        return;
    }

    if (args.command === 'download' && args.url) {
        const loggedIn = await ensureLogin();
        if (!loggedIn) {
            console.log('Login required. Exiting.');
            return;
        }
        if (!args.skipVideos && !await ensureFfmpeg()) {
            process.exitCode = 1;
            return;
        }
        if (isClassroomRootUrl(args.url)) {
            const logger = buildInteractiveLogger();
            const library = await fetchCourseLibrary(args.url, logger);
            const outputRoot = args.outputDir && args.outputDir !== 'undefined' ? args.outputDir : undefined;
            let failedCourses = 0;
            const { accessible, locked } = filterAccessibleCourses(library.courses);

            if (locked.length > 0) {
                console.warn(`Skipping ${locked.length} locked course${locked.length === 1 ? '' : 's'} (no access).`);
            }

            if (accessible.length === 0) {
                console.warn('No accessible courses found to download.');
                return;
            }

            let totalFailures = 0;
            for (const course of accessible) {
                try {
                    const summary = await downloadCourse({
                        url: course.url,
                        outputDir: outputRoot ? resolveCourseOutputDir(outputRoot, library.groupName, course.title) : undefined,
                        concurrency: args.concurrency,
                        mode: 'course',
                        skipVideos: args.skipVideos
                    });
                    totalFailures += summary.failures.length;
                } catch (err) {
                    failedCourses += 1;
                    console.error(`Failed to download course ${course.title}: ${String(err)}`);
                }
            }

            if (failedCourses > 0 || totalFailures > 0) {
                console.warn(`${failedCourses} courses failed, ${totalFailures} lessons/videos failed (see .download-failures.json in each course).`);
                process.exitCode = 1;
            }
            return;
        }

        await downloadCourse({
            url: args.url,
            outputDir: args.outputDir,
            concurrency: args.concurrency,
            mode: args.mode,
            lessonId: args.lessonId,
            skipVideos: args.skipVideos
        });
        return;
    }

    await runInteractive();
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    await runWithArgs(args);
}

main().catch((error) => {
    console.error('❌ An error occurred:', error);
    process.exit(1);
});
