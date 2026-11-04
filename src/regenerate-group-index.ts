import fs from 'fs-extra';
import path from 'path';
import { formatDate } from './utils.js';
import { renderProgressScript } from './progress-sync.js';

type CourseManifest = {
    courseName: string;
    groupName: string;
    position?: number;
    courseImageUrl?: string;
    courseImagePath?: string;
    modules: Array<{
        index: number;
        title: string;
        moduleDirName: string;
    }>;
    updatedAt: string;
};

type GroupIndexCourse = {
    dirName: string;
    courseName: string;
    groupName?: string;
    courseImagePath?: string;
    modulesCount: number;
    lessonsCount: number;
    lessonIds: string[];
    position?: number;
    updatedAt?: string;
};

type RegenerateOptions = {
    silent?: boolean;
};

async function writeAtomicHtml(filePath: string, content: string) {
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, content);
    await fs.move(tempPath, filePath, { overwrite: true });
}

async function countLessons(coursePath: string, dirName: string) {
    let modulesCount = 0;
    const lessonIds: string[] = [];

    const moduleEntries = await fs.readdir(coursePath, { withFileTypes: true });
    const moduleDirs: typeof moduleEntries = [];
    const rootLessonDirs: typeof moduleEntries = [];

    for (const entry of moduleEntries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'assets') continue;
        const entryPath = path.join(coursePath, entry.name);
        const indexPath = path.join(entryPath, 'index.html');
        const manifestPath = path.join(entryPath, 'lesson.json');
        if (await fs.pathExists(indexPath) || await fs.pathExists(manifestPath)) {
            rootLessonDirs.push(entry);
        } else {
            moduleDirs.push(entry);
        }
    }

    modulesCount = moduleDirs.length + (rootLessonDirs.length > 0 ? 1 : 0);

    for (const moduleDir of moduleDirs) {
        const modulePath = path.join(coursePath, moduleDir.name);
        const lessonEntries = await fs.readdir(modulePath, { withFileTypes: true });
        const lessonDirs = lessonEntries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

        for (const lessonDir of lessonDirs) {
            const lessonPath = path.join(modulePath, lessonDir.name);
            const indexPath = path.join(lessonPath, 'index.html');
            const manifestPath = path.join(lessonPath, 'lesson.json');

            if (await fs.pathExists(indexPath) || await fs.pathExists(manifestPath)) {
                let relativePath = `${moduleDir.name}/${lessonDir.name}/index.html`;
                if (await fs.pathExists(manifestPath)) {
                    try {
                        const manifest = await fs.readJson(manifestPath);
                        if (manifest.relativePath) relativePath = manifest.relativePath;
                    } catch {}
                }
                lessonIds.push(`${dirName}/${relativePath.replace(/\\/g, '/')}`);
            }
        }
    }

    for (const lessonDir of rootLessonDirs) {
        const lessonPath = path.join(coursePath, lessonDir.name);
        const indexPath = path.join(lessonPath, 'index.html');
        const manifestPath = path.join(lessonPath, 'lesson.json');
        if (await fs.pathExists(indexPath) || await fs.pathExists(manifestPath)) {
            let relativePath = `${lessonDir.name}/index.html`;
            if (await fs.pathExists(manifestPath)) {
                try {
                    const manifest = await fs.readJson(manifestPath);
                    if (manifest.relativePath) relativePath = manifest.relativePath;
                } catch {}
            }
            lessonIds.push(`${dirName}/${relativePath.replace(/\\/g, '/')}`);
        }
    }

    return { modulesCount, lessonsCount: lessonIds.length, lessonIds };
}

async function loadCourseInfo(coursePath: string, dirName: string): Promise<GroupIndexCourse | null> {
    const manifestPath = path.join(coursePath, '.course.json');
    let manifest: CourseManifest | null = null;
    if (await fs.pathExists(manifestPath)) {
        try {
            manifest = await fs.readJson(manifestPath);
        } catch {
            manifest = null;
        }
    }

    const courseName = manifest?.courseName || dirName;
    const groupName = manifest?.groupName;
    let courseImagePath = manifest?.courseImagePath;
    if (!courseImagePath) {
        for (const ext of [".jpg", ".jpeg", ".png", ".webp"]) {
            if (await fs.pathExists(path.join(coursePath, `assets/course-cover${ext}`))) {
                courseImagePath = `assets/course-cover${ext}`;
                break;
            }
        }
    }
    const counts = await countLessons(coursePath, dirName);

    return {
        dirName,
        courseName,
        groupName,
        courseImagePath,
        modulesCount: counts.modulesCount,
        lessonsCount: counts.lessonsCount,
        lessonIds: counts.lessonIds,
        position: typeof manifest?.position === 'number' ? manifest.position : undefined,
        updatedAt: manifest?.updatedAt
    };
}

async function regenerateGroupIndex(
    groupDir: string,
    options: RegenerateOptions = {}
) {
    const log = options.silent ? () => {} : console.log;
    const warn = options.silent ? () => {} : console.warn;

    if (!fs.existsSync(groupDir)) {
        log(`Group directory not found: ${groupDir}`);
        return;
    }

    const entries = await fs.readdir(groupDir, { withFileTypes: true });
    const courseDirs = entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

    const courses: GroupIndexCourse[] = [];
    let resolvedGroupName: string | null = null;

    for (const courseDir of courseDirs) {
        const coursePath = path.join(groupDir, courseDir.name);
        const courseInfo = await loadCourseInfo(coursePath, courseDir.name);
        if (!courseInfo) continue;

        courses.push(courseInfo);
        if (!resolvedGroupName && courseInfo.groupName) {
            resolvedGroupName = courseInfo.groupName;
        }
    }

    if (courses.length === 0) {
        warn('No courses found to build group index.');
        return;
    }

    const groupName = resolvedGroupName || path.basename(groupDir);

    // The classroom's order. Courses saved before it was recorded go after,
    // most recently downloaded first.
    courses.sort((a, b) => {
        if (a.position !== undefined || b.position !== undefined) {
            if (a.position === undefined) return 1;
            if (b.position === undefined) return -1;
            if (a.position !== b.position) return a.position - b.position;
        }
        if (a.updatedAt && b.updatedAt) {
            return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        }
        return a.courseName.localeCompare(b.courseName);
    });

    const totalLessons = courses.reduce((acc, course) => acc + course.lessonsCount, 0);
    const courseLessonsMap: Record<string, string[]> = {};
    courses.forEach(c => {
        courseLessonsMap[c.dirName] = c.lessonIds;
    });

    const courseCards = await Promise.all(
        courses.map(async (course) => {
            const coursePath = path.join(groupDir, course.dirName);
            const courseIndexPath = `${course.dirName}/index.html`;
            let imageMarkup = '<div class="course-fallback">No course image</div>';

            if (course.courseImagePath) {
                const resolvedImagePath = path.join(coursePath, course.courseImagePath);
                if (await fs.pathExists(resolvedImagePath)) {
                    const imageSrc = `${course.dirName}/${course.courseImagePath}`;
                    imageMarkup = `<img src="${imageSrc}" alt="${course.courseName} cover">`;
                }
            }

            const updatedLabel = course.updatedAt
                ? formatDate(course.updatedAt)
                : 'Unknown';

            return `
                <a class="course-card" href="${courseIndexPath}" data-course-dir="${course.dirName}">
                    <div class="course-image">${imageMarkup}</div>
                    <div class="course-body">
                        <div class="course-card-header">
                            <h2>${course.courseName}</h2>
                            <span class="course-tick" data-course-dir="${course.dirName}" role="button" title="Marcar curso completo" aria-label="Marcar curso completo">
                                <svg viewBox="0 0 20 20" fill="none"><path d="M4.5 10.5L8 14L15.5 5.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
                            </span>
                        </div>
                        <p class="course-meta">Updated ${updatedLabel}</p>
                        <div class="course-stats">
                            <span><strong>${course.modulesCount}</strong> modules</span>
                            <span><strong>${course.lessonsCount}</strong> lessons</span>
                            <span class="course-progress-badge"><strong>0</strong> / ${course.lessonsCount} completadas</span>
                        </div>
                    </div>
                </a>
            `;
        })
    );

        const coverCandidates = ["portada.png", "portada.jpg", "cover.png", "cover.jpg"];
    let groupCoverImage: string | null = null;
    for (const cand of coverCandidates) {
        if (fs.existsSync(path.join(groupDir, cand))) {
            groupCoverImage = cand;
            break;
        }
    }

    const indexHtml = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>${groupName} - Courses</title>
            <style>
                :root {
                    --bg: #f8f6f1;
                    --panel: #ffffff;
                    --panel-2: #f5f7fb;
                    --text: #16181f;
                    --muted: #5c6575;
                    --accent: #3b82f6;
                    --accent-2: #0f172a;
                    --ring: rgba(20,22,29,0.08);
                    --shadow: 0 18px 36px rgba(15, 23, 42, 0.12);
                }
                * { box-sizing: border-box; }
                body {
                    margin: 0;
                    font-family: "Space Grotesk", "Manrope", "Segoe UI", sans-serif;
                    background: #f6f6f8;
                    color: var(--text);
                    line-height: 1.6;
                }
                .page {
                    max-width: 1100px;
                    margin: 48px auto 80px;
                    padding: 0 24px;
                }
                .hero {
                    ${groupCoverImage ? "display: grid; grid-template-columns: 1fr; gap: 28px; align-items: center;" : ""}
                    background: linear-gradient(180deg, rgba(255,255,255,0.97) 0%, rgba(255,255,255,0.92) 100%);
                    border-radius: 26px;
                    padding: 32px;
                    box-shadow:
                        0 25px 45px rgba(15, 23, 42, 0.18),
                        0 10px 20px rgba(15, 23, 42, 0.08);
                }
                .hero-copy {
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    gap: 6px;
                }
                .hero-title {
                    font-size: clamp(2.3rem, 4vw, 3.2rem);
                    margin: 0 0 8px 0;
                    letter-spacing: -0.02em;
                }
                .hero-subtitle {
                    color: var(--muted);
                    margin: 0 0 18px 0;
                    font-size: 1.05rem;
                }
                .hero-meta {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 12px;
                }
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
                .chip {
                    padding: 10px 14px;
                    border-radius: 999px;
                    background: var(--panel-2);
                    border: 1px solid var(--ring);
                    color: var(--text);
                    font-size: 0.95rem;
                }
                .chip strong { color: var(--accent); font-weight: 700; }
                .courses {
                    margin-top: 32px;
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
                    gap: 18px;
                }
                .course-card {
                    background: var(--panel);
                    border: 1px solid rgba(15, 23, 42, 0.05);
                    border-radius: 18px;
                    overflow: hidden;
                    text-decoration: none;
                    color: inherit;
                    display: flex;
                    flex-direction: column;
                    min-height: 100%;
                    transition: transform 0.25s ease, box-shadow 0.25s ease;
                    box-shadow: 0 20px 40px rgba(15, 23, 42, 0.12);
                }
                .course-card:hover {
                    transform: translateY(-6px);
                    box-shadow:
                        0 30px 60px rgba(15, 23, 42, 0.25),
                        0 14px 30px rgba(15, 23, 42, 0.15);
                }
                .course-image {
                    aspect-ratio: 16 / 9;
                    min-height: 0;
                    background: #020617;
                    border-bottom: 1px solid var(--ring);
                    overflow: hidden;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                }
                .course-image img {
                    width: 100%;
                    height: 100%;
                    object-fit: contain;
                    display: block;
                }
                .course-fallback {
                    height: 100%;
                    display: grid;
                    place-items: center;
                    color: var(--muted);
                    font-size: 0.95rem;
                }
                .course-body {
                    padding: 18px 18px 20px;
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                }
                .course-card-header {
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 12px;
                }
                .course-card-header h2 {
                    margin: 0;
                    font-size: 1.2rem;
                    flex: 1;
                }
                .course-tick {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    width: 24px;
                    height: 24px;
                    min-width: 24px;
                    border-radius: 50%;
                    background: #ffffff;
                    border: 2px solid #cbd5e1;
                    color: #94a3b8;
                    cursor: pointer;
                    transition: all 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275);
                    padding: 0;
                    flex-shrink: 0;
                    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
                }
                .course-tick svg {
                    width: 14px;
                    height: 14px;
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
                .course-meta {
                    margin: 0;
                    color: var(--muted);
                    font-size: 0.95rem;
                }
                .course-stats {
                    display: flex;
                    flex-wrap: wrap;
                    gap: 12px;
                    font-size: 0.95rem;
                }
                .course-stats strong { color: var(--accent-2); }
                .course-progress-badge {
                    color: var(--muted);
                }
                .course-progress-badge strong {
                    color: var(--accent);
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
                ${groupCoverImage ? "@media (min-width: 900px) { .hero { grid-template-columns: 1.15fr 0.85fr; } }" : ""}
            </style>
        </head>
        <body>
            <div class="page">
                <section class="hero">
                    <div class="hero-copy">
                        <h1 class="hero-title">${groupName}</h1>
                        <p class="hero-subtitle">All downloaded courses for this community.</p>
                        <div class="hero-meta">
                            <div class="chip" id="globalProgressChip">Progreso: <strong>0 / ${totalLessons}</strong> completadas</div>
                            <div class="chip"><strong>${courses.length}</strong> courses</div>
                            <div class="chip"><strong>${totalLessons}</strong> lessons</div>
                            <div class="chip">Updated: <strong>${formatDate()}</strong></div>
                        </div>
                    </div>
                    ${groupCoverImage ? `
                    <div class="hero-image">
                        <img src="${groupCoverImage}" alt="${groupName} portada">
                    </div>` : ""}
                </section>
                <section class="courses">
                    ${courseCards.join('')}
                </section>
            </div>
            ${renderProgressScript(`
    const COURSE_LESSONS = ${JSON.stringify(courseLessonsMap).replace(/</g, '\\u003c')};
    const TOTAL_LESSONS = ${totalLessons};

    function render(data) {
        let globalCount = 0;
        document.querySelectorAll('.course-card').forEach(card => {
            const lessonIds = COURSE_LESSONS[card.getAttribute('data-course-dir')] || [];
            const courseCount = lessonIds.filter(id => data[id]).length;
            globalCount += courseCount;

            const badge = card.querySelector('.course-progress-badge');
            if (badge) badge.innerHTML = '<strong>' + courseCount + '</strong> / ' + lessonIds.length + ' completadas';

            const tick = card.querySelector('.course-tick');
            if (tick) {
                const isAllDone = lessonIds.length > 0 && courseCount === lessonIds.length;
                tick.classList.toggle('is-completed', isAllDone);
                tick.setAttribute('aria-pressed', isAllDone ? 'true' : 'false');
                tick.setAttribute('title', isAllDone ? 'Marcar curso como incompleto' : 'Marcar curso completo');
            }
        });

        const globalChip = document.getElementById('globalProgressChip');
        if (globalChip) globalChip.innerHTML = 'Progreso: <strong>' + globalCount + ' / ' + TOTAL_LESSONS + '</strong> completadas';
    }

    document.addEventListener('click', (e) => {
        const tick = e.target.closest('.course-tick');
        if (!tick) return;
        e.preventDefault();
        e.stopPropagation();

        const lessonIds = COURSE_LESSONS[tick.getAttribute('data-course-dir')] || [];
        if (!lessonIds.length) return;

        const data = getCompleted();
        const allDone = lessonIds.every(id => !!data[id]);
        lessonIds.forEach(id => { if (allDone) delete data[id]; else data[id] = true; });
        saveCompleted(data, true);
        render(data);
    });

    startProgressSync(render);
`)}
        </body>
        </html>
    `;

    await writeAtomicHtml(path.join(groupDir, 'index.html'), indexHtml);

    log('\nGroup index regenerated successfully.');
    log(`Saved to: ${path.join(groupDir, 'index.html')}`);
}

export { regenerateGroupIndex };
