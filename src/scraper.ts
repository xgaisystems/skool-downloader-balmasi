import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'fs-extra';
import { createConsoleLogger, type Logger } from './logger.js';
import { STORAGE_STATE_PATH } from './auth.js';
import { escapeHtml } from './utils.js';
import { renderPostMarkdown } from './linked-posts.js';

export interface Resource {
    title: string;
    file_id?: string;
    file_name?: string;
    file_content_type?: string;
    downloadUrl?: string;
    isExternal?: boolean;
}

export interface LinkedPost {
    id: string;
    name: string;
    title: string;
    url: string;
    authorName: string;
    createdAt?: string;
    contentHtml: string;
    attachments: Resource[];
    // The post page could not be read, so this holds only what the lesson page
    // carries: text cut at metadata.contentLimit and no attachments.
    incomplete: boolean;
}

export interface Lesson {
    id: string;
    title: string;
    url: string;
    index?: number;
    contentHtml?: string;
    videoLink?: string;
    // Skool's own (Mux) video id, for lessons whose video is hosted on Skool.
    videoId?: string;
    resources?: Resource[];
    linkedPosts?: LinkedPost[];
}

export interface Module {
    title: string;
    index: number;
    lessons: Lesson[];
    root?: boolean;
}

export interface ClassroomResult {
    groupName: string;
    courseName: string;
    courseImageUrl?: string;
    modules: Module[];
}

export interface CourseListItem {
    id?: string;
    name?: string;
    title: string;
    url: string;
    key: string;
    numModules?: number;
    coverImageUrl?: string;
    hasAccess?: boolean;
    privacy?: number;
    updatedAt?: string;
}

export interface CourseLibraryResult {
    groupName: string;
    classroomUrl: string;
    courses: CourseListItem[];
}

const POST_NAVIGATION_DELAY_MS = 2000;

function resolveClassroomRootUrl(inputUrl: string) {
    const urlObj = new URL(inputUrl);
    const segments = urlObj.pathname.split('/').filter(Boolean);
    const classroomIndex = segments.indexOf('classroom');
    if (classroomIndex === -1) {
        urlObj.search = '';
        urlObj.hash = '';
        return urlObj.toString();
    }
    const baseSegments = segments.slice(0, classroomIndex + 1);
    urlObj.pathname = `/${baseSegments.join('/')}`;
    urlObj.search = '';
    urlObj.hash = '';
    return urlObj.toString();
}

// Skool sends visitors without access to a group's classroom to its /about
// landing page, whose __NEXT_DATA__ carries no course data at all.
function assertClassroomAccess(nextData: any, requestedUrl: string) {
    if (nextData?.page !== '/[group]/about') return;

    const pageProps = nextData.props?.pageProps || {};
    const groupName = pageProps.currentGroup?.metadata?.displayName || pageProps.currentGroup?.name || 'this community';
    const accountName = pageProps.self?.name;

    if (!accountName) {
        throw new Error(
            `Skool redirected ${requestedUrl} to the "${groupName}" about page because you are not logged in. ` +
            `Run "skool login" and try again.`
        );
    }
    throw new Error(
        `Skool redirected ${requestedUrl} to the "${groupName}" about page: the logged-in account "${accountName}" ` +
        `is not a member of this community, or its membership has expired. ` +
        `Join it with this account, or run "skool login" with the account that is a member.`
    );
}

export class Scraper {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;
    private logger: Logger;

    constructor(logger: Logger = createConsoleLogger()) {
        this.logger = logger;
    }

    async init() {
        this.browser = await chromium.launch({ headless: true });
        if (fs.existsSync(STORAGE_STATE_PATH)) {
            this.context = await this.browser.newContext({ storageState: STORAGE_STATE_PATH });
        } else {
            this.context = await this.browser.newContext();
        }
    }

    async close() {
        if (this.browser) await this.browser.close();
    }

    async parseClassroom(url: string): Promise<ClassroomResult> {
        if (!this.context) await this.init();
        const page = await this.context!.newPage();

        // Ensure we are using a clean classroom URL without query params for structure extraction
        const cleanUrl = url.split('?')[0]!;
        this.logger.info(`Navigating to ${cleanUrl}...`);
        await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);

        const nextData = await page.evaluate(() => {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? JSON.parse(script.innerText) : null;
        });

        await page.close();

        if (!nextData) throw new Error('Could not find __NEXT_DATA__ on classroom page');
        assertClassroomAccess(nextData, cleanUrl);

        const pageProps = nextData.props?.pageProps || {};
        const courseData = pageProps.course;

        if (!courseData || !courseData.children) {
            this.logger.debug(`DEBUG: course metadata: ${JSON.stringify(courseData?.course?.metadata ?? {})}`);
            throw new Error('Course structure not found in __NEXT_DATA__');
        }

        // Extract Group (Community) Name
        const groupData = pageProps.currentGroup || {};
        const groupName = groupData.metadata?.name || groupData.name || 'Unknown Group';

        // Extract Course Name
        let courseName = 'Unknown Course';
        if (courseData.metadata?.title) {
            courseName = courseData.metadata.title;
        } else if (courseData.course?.metadata?.title) {
            courseName = courseData.course.metadata.title;
        } else {
            // Fallback: match current URL segment with allCourses/renderData.allCourses
            const urlParts = cleanUrl.split('/');
            const urlCourseHandle = urlParts[urlParts.length - 1]; // e.g. "767876d4"
            const allCourses = pageProps.allCourses || pageProps.renderData?.allCourses || [];
            const foundCourse = allCourses.find((c: any) => c.name === urlCourseHandle);
            if (foundCourse?.metadata?.title) {
                courseName = foundCourse.metadata.title;
            }
        }

        // Extract Course Image
        let courseImageUrl: string | undefined =
            courseData.metadata?.coverImage ||
            courseData.metadata?.image ||
            courseData.metadata?.coverSmallUrl ||
            courseData.course?.metadata?.coverImage ||
            courseData.course?.metadata?.image ||
            courseData.course?.metadata?.coverSmallUrl;

        if (!courseImageUrl) {
            const urlParts = cleanUrl.split('/');
            const urlCourseHandle = urlParts[urlParts.length - 1];
            const allCourses = pageProps.allCourses || pageProps.renderData?.allCourses || [];
            const foundCourse = allCourses.find((c: any) => c.name === urlCourseHandle || c.id === courseData?.id);
            courseImageUrl =
                foundCourse?.metadata?.coverImage ||
                foundCourse?.metadata?.image ||
                foundCourse?.metadata?.coverSmallUrl;
        }

        this.logger.info(`🎓 Course detected: ${courseName}`);

        // Skool Hierarchy:
        // Children can be sets (modules) or standalone lessons.
        const modules: Module[] = [];
        let rootModule: Module | null = null;

        const childNodes = Array.isArray(courseData.children) ? courseData.children : [];
        childNodes.forEach((node: any) => {
            if (node?.children && node.children.length > 0) {
                const setInfo = node.course || {};
                const setTitle = setInfo.metadata?.title || setInfo.name || 'Untitled Section';

                const lessons: Lesson[] = (node.children || []).map((mod: any, lIdx: number) => {
                    const modInfo = mod.course || {};
                    return {
                        id: modInfo.id,
                        title: modInfo.metadata?.title || modInfo.name || 'Untitled Lesson',
                        url: `${cleanUrl}?md=${modInfo.id}`,
                        index: lIdx + 1
                    };
                }).filter((l: Lesson) => l.id);

                modules.push({
                    title: setTitle,
                    index: modules.length + 1,
                    lessons
                });
                return;
            }

            const lessonInfo = node?.course || {};
            if (lessonInfo?.id) {
                if (!rootModule) {
                    rootModule = {
                        title: 'Lessons',
                        index: modules.length + 1,
                        lessons: [],
                        root: true
                    };
                    modules.push(rootModule);
                }

                rootModule.lessons.push({
                    id: lessonInfo.id,
                    title: lessonInfo.metadata?.title || lessonInfo.name || 'Untitled Lesson',
                    url: `${cleanUrl}?md=${lessonInfo.id}`,
                    index: rootModule.lessons.length + 1
                });
            }
        });

        return {
            groupName,
            courseName,
            courseImageUrl,
            modules: modules.filter(m => m.lessons.length > 0)
        };
    }

    async parseCourseLibrary(url: string): Promise<CourseLibraryResult> {
        if (!this.context) await this.init();
        const page = await this.context!.newPage();

        const classroomUrl = resolveClassroomRootUrl(url);
        this.logger.info(`Navigating to ${classroomUrl}...`);
        await page.goto(classroomUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);

        const nextData = await page.evaluate(() => {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? JSON.parse(script.innerText) : null;
        });

        await page.close();

        if (!nextData) throw new Error('Could not find __NEXT_DATA__ on classroom page');
        assertClassroomAccess(nextData, classroomUrl);

        const pageProps = nextData.props?.pageProps || {};
        const allCourses = pageProps.allCourses || pageProps.renderData?.allCourses || [];

        if (!Array.isArray(allCourses) || allCourses.length === 0) {
            throw new Error('No courses found in classroom __NEXT_DATA__.');
        }

        const groupData = pageProps.currentGroup || {};
        const groupName =
            groupData.metadata?.displayName ||
            groupData.metadata?.name ||
            groupData.name ||
            'Unknown Group';

        const baseUrl = classroomUrl.replace(/\/$/, '');

        const courses: CourseListItem[] = allCourses.map((course: any, index: number) => {
            const metadata = course.metadata || {};
            const courseSlug = course.name || course.id;
            const title = metadata.title || course.name || course.id || `Course ${index + 1}`;
            const url = courseSlug ? `${baseUrl}/${courseSlug}` : baseUrl;
            const hasAccess =
                metadata.hasAccess === 1 ? true : metadata.hasAccess === 0 ? false : undefined;

            return {
                id: course.id,
                name: course.name,
                title,
                url,
                key: course.id || course.name || url,
                numModules: metadata.numModules,
                coverImageUrl: metadata.coverImage || metadata.coverSmallUrl || metadata.image,
                hasAccess,
                privacy: metadata.privacy,
                updatedAt: course.updatedAt
            };
        }).filter(course => course.url !== baseUrl);

        if (courses.length === 0) {
            throw new Error('No valid courses found in classroom listing.');
        }

        return {
            groupName,
            classroomUrl,
            courses
        };
    }

    // resolveNativeVideo: false skips the play click that signs a native video's
    // stream URL, for runs that do not download videos.
    async extractLessonData(url: string, { resolveNativeVideo = true }: { resolveNativeVideo?: boolean } = {}): Promise<Lesson> {
        if (!this.context) await this.init();
        const page = await this.context!.newPage();

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);

        const nextData = await page.evaluate(() => {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? JSON.parse(script.innerText) : null;
        });

        if (!nextData) throw new Error(`Could not find __NEXT_DATA__ for lesson at ${url}`);

        const pageProps = nextData.props?.pageProps || {};
        const urlObj = new URL(url);
        const md = urlObj.searchParams.get('md') || urlObj.searchParams.get('lesson');

        let foundLesson: any = null;

        const findInTree = (node: any) => {
            if (node.course?.id === md) {
                foundLesson = node.course;
                return;
            }
            if (node.children) {
                for (const child of node.children) {
                    findInTree(child);
                    if (foundLesson) return;
                }
            }
        };

        if (pageProps.course) {
            findInTree(pageProps.course);
        }

        if (!foundLesson) {
            foundLesson = pageProps.lesson || pageProps.course?.course;
        }

        const metadata = foundLesson?.metadata || {};

        // Handle native videoId vs videoLink
        let vLink = metadata.videoLink || foundLesson?.video?.url || '';

        // Native Skool Player Handling (Mux)
        if (!vLink && metadata.videoId && resolveNativeVideo) {
            this.logger.info(`    ℹ️ Native videoId found: ${metadata.videoId}.`);

            try {
                // Try to find and click the play button/thumbnail to trigger stream signed URL generation
                const playButtonSelector = 'div[class*="MuxThumbnailWrapper"]';
                const hasPlayButton = await page.evaluate((sel) => !!document.querySelector(sel), playButtonSelector);

                if (hasPlayButton) {
                    this.logger.info('    🖱️ Clicking play button to initialize stream...');
                    await page.click(playButtonSelector);

                    // Poll for the stream manifest to appear in network entries or player src
                    let attempts = 0;
                    while (attempts < 10) {
                        vLink = await page.evaluate(() => {
                            // 1. Check performance entries for m3u8
                            const entries = performance.getEntriesByType('resource')
                                .filter(e => e.name.includes('m3u8') && e.name.includes('token='));
                            if (entries.length > 0) return (entries[entries.length - 1] as PerformanceResourceTiming).name;

                            // 2. Search all shadow roots for a video element (BFS)
                            const stack: any[] = [document];
                            while (stack.length > 0) {
                                const root = stack.pop();
                                const video = root.querySelector('video');
                                if (video && video.src && video.src.includes('m3u8')) return video.src;

                                const elements = root.querySelectorAll('*');
                                for (let i = 0; i < elements.length; i++) {
                                    if (elements[i].shadowRoot) {
                                        stack.push(elements[i].shadowRoot);
                                    }
                                }
                            }
                            return null;
                        });

                        if (vLink) break;
                        await page.waitForTimeout(1000);
                        attempts++;
                    }
                }

                // Fallback: Reconstruct from pageProps if interaction failed but we have IDs
                if (!vLink) {
                    const videoData = pageProps.video || pageProps.course?.video;
                    if (videoData && videoData.id === metadata.videoId && videoData.playbackId && videoData.playbackToken) {
                        this.logger.info('    ℹ️ Using reconstructed HLS URL from page props fallback.');
                        vLink = `https://stream.video.skool.com/${videoData.playbackId}.m3u8?token=${videoData.playbackToken}`;
                    }
                }
            } catch (err) {
                this.logger.warn(`    ⚠️ Interaction-based extraction failed: ${String(err)}`);
            }
        }

        // Resource extraction
        let resources: Resource[] = [];
        try {
            // 1. Try to extract from metadata (standard native files)
            const rawResources = metadata.resources || foundLesson?.resources || '[]';
            if (typeof rawResources === 'string') {
                resources = JSON.parse(rawResources);
            } else if (Array.isArray(rawResources)) {
                resources = rawResources;
            }

            // Normalize metadata resources (some have .link instead of .downloadUrl)
            resources = resources.map((r: any) => {
                if (r.link && !r.downloadUrl) {
                    return {
                        ...r,
                        downloadUrl: r.link,
                        isExternal: true
                    };
                }
                return r;
            });

        } catch (e) {
            this.logger.warn(`    ⚠️ Failed to parse metadata resources: ${String(e)}`);
        }

        // 2. Scrape from DOM to catch external links and any native missing from metadata
        try {
            const domResources = await page.evaluate(() => {
                const wrappers = Array.from(document.querySelectorAll('div[class*="ResourceWrapper"]'));
                return wrappers.map(w => {
                    const anchor = w.querySelector('a');
                    const labelSpan = w.querySelector('span[class*="ResourceLabel"]');
                    const title = labelSpan ? labelSpan.textContent?.trim() : 'Untitled Resource';
                    
                    const url = anchor ? anchor.href : null;
                    // If it has an anchor and it's not a skool download link, it's external
                    const isExternal = !!(url && !url.includes('api2.skool.com') && !url.includes('/files/'));

                    return { title, url, isExternal };
                });
            });

            // Merge DOM resources into the metadata resources
            for (const domRes of domResources) {
                const exists = resources.some(r => r.title === domRes.title);
                if (!exists && domRes.title) {
                    if (domRes.isExternal && domRes.url) {
                        resources.push({
                            title: domRes.title,
                            downloadUrl: domRes.url,
                            isExternal: true,
                            file_name: domRes.title
                        });
                    } else {
                        // If it's native but wasn't in metadata, it might be a link-style resource 
                        // that still points to a skool file.
                        if (domRes.url) {
                            resources.push({
                                title: domRes.title,
                                downloadUrl: domRes.url,
                                file_name: domRes.title
                            });
                        }
                    }
                }
            }
        } catch (err) {
            this.logger.warn(`    ⚠️ DOM-based resource scraping failed: ${String(err)}`);
        }

        // Fetch download URLs for each native resource using direct API calls
        if (resources.length > 0) {
            this.logger.info(`    📥 Found ${resources.length} resources. Fetching download URLs...`);

            for (const res of resources) {
                // Skip if it's already an external link or already has a download URL
                if (res.isExternal || (res.downloadUrl && res.downloadUrl.startsWith('http')) || !res.file_id) {
                    continue;
                }

                try {
                    this.logger.info(`      🔗 Requesting download URL for "${res.title}"...`);
                    const response = await page.evaluate(async (fileId: string) => {
                        const apiUrl = `https://api2.skool.com/files/${fileId}/download-url?expire=28800`;
                        try {
                            const resp = await fetch(apiUrl, {
                                method: 'POST',
                                credentials: 'include'
                            });
                            if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` };
                            const text = await resp.text();
                            return { success: true, url: text.trim() };
                        } catch (e) {
                            return { success: false, error: String(e) };
                        }
                    }, res.file_id);

                    if (response.success && response.url) {
                        res.downloadUrl = response.url;
                        this.logger.info(`      ✅ Got download URL for "${res.title}"`);
                    } else {
                        this.logger.warn(`      ⚠️ Failed to get download URL for "${res.title}": ${response.error}`);
                    }
                } catch (err) {
                    this.logger.warn(`      ⚠️ Error fetching download URL for "${res.title}": ${String(err)}`);
                }
            }
        }

        const linkedPosts = await this.extractLinkedPosts(page, pageProps.pinnedPosts, urlObj);

        await page.close();

        // Skool stores rich text as a stringified JSON array or primitive HTML
        let body = metadata.desc || foundLesson?.body || '';

        // If it looks like [v2][{"type"...}], it's TipTap/JSON format
        if (typeof body === 'string' && (body.startsWith('[v2]') || (body.startsWith('[') && body.includes('"type"')))) {
            try {
                const jsonPart = body.startsWith('[v2]') ? body.substring(4) : body;
                const nodes = JSON.parse(jsonPart);
                body = this.parseTipTap(nodes);
            } catch (e) {
                this.logger.error(`Failed to parse TipTap content: ${String(e)}`);
            }
        }

        return {
            id: md || foundLesson?.id || '',
            title: metadata.title || foundLesson?.name || '',
            url: url,
            contentHtml: body,
            videoLink: vLink,
            videoId: metadata.videoId || undefined,
            resources: resources,
            linkedPosts
        };
    }

    // Community posts pinned to a lesson show up as cards under its body. The
    // lesson's pageProps.pinnedPosts lists them but truncates the text at
    // metadata.contentLimit and leaves out attachmentsData, so each post's own
    // page is the source of truth. This navigates `page` away from the lesson.
    private async extractLinkedPosts(page: Page, pinnedPosts: unknown, lessonUrl: URL): Promise<LinkedPost[]> {
        if (!Array.isArray(pinnedPosts) || pinnedPosts.length === 0) return [];

        const groupSlug = lessonUrl.pathname.split('/').filter(Boolean)[0];
        const linkedPosts: LinkedPost[] = [];

        for (const entry of pinnedPosts) {
            const pinned = entry?.post;
            if (!pinned?.name) continue;

            const url = `${lessonUrl.origin}/${groupSlug}/${pinned.name}`;
            let fullPost: any = null;
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                const nextData = await page.evaluate(() => {
                    const script = document.getElementById('__NEXT_DATA__');
                    return script ? JSON.parse(script.innerText) : null;
                });
                const post = nextData?.props?.pageProps?.postTree?.post;
                if (post?.id === pinned.id) fullPost = post;
            } catch (err) {
                this.logger.warn(`    ⚠️ Failed to open post ${url}: ${String(err)}`);
            }
            if (!fullPost) {
                this.logger.warn(`    ⚠️ Keeping the partial copy of post ${url} from the lesson page.`);
            }

            const post = fullPost ?? pinned;
            const metadata = post.metadata || {};
            const user = post.user || {};
            linkedPosts.push({
                id: post.id,
                name: post.name,
                title: metadata.title || post.name,
                url,
                authorName: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.name || '',
                createdAt: post.createdAt,
                contentHtml: renderPostMarkdown(metadata.content || ''),
                attachments: this.parsePostAttachments(metadata.attachmentsData, url),
                incomplete: !fullPost
            });

            // Every post is one more navigation on top of the lesson's own, and
            // CloudFront answers bursts of them with a 403 for the whole site.
            await page.waitForTimeout(POST_NAVIGATION_DELAY_MS);
        }

        this.logger.info(`    📌 Found ${linkedPosts.length} community posts linked to this lesson.`);
        return linkedPosts;
    }

    private parsePostAttachments(attachmentsData: unknown, postUrl: string): Resource[] {
        if (typeof attachmentsData !== 'string' || !attachmentsData) return [];
        try {
            const attachments: any[] = JSON.parse(attachmentsData);
            return attachments
                .filter(a => a?.metadata?.read_url)
                .map(a => ({
                    title: a.metadata.file_name || a.id,
                    file_id: a.id,
                    file_name: a.metadata.file_name,
                    file_content_type: a.metadata.content_type,
                    downloadUrl: a.metadata.read_url
                }));
        } catch (err) {
            this.logger.warn(`    ⚠️ Failed to parse attachments of post ${postUrl}: ${String(err)}`);
            return [];
        }
    }

    // Helper removed as logic is now in extractLessonData for shared state

    private parseTipTap(nodes: any[]): string {
        if (!Array.isArray(nodes)) return '';
        return nodes.map(node => {
            if (!node) return '';

            if (node.type === 'paragraph') {
                return `<p>${this.parseTipTapContent(node.content)}</p>`;
            }
            if (node.type === 'hardBreak') {
                return '<br/>';
            }
            if (node.type === 'horizontalRule') {
                return '<hr/>';
            }
            if (node.type === 'bulletList') {
                return `<ul>${this.parseTipTap(node.content)}</ul>`;
            }
            if (node.type === 'orderedList') {
                const start = node.attrs?.start ? ` start="${node.attrs.start}"` : '';
                return `<ol${start}>${this.parseTipTap(node.content)}</ol>`;
            }
            if (node.type === 'listItem') {
                return `<li>${this.parseTipTap(node.content)}</li>`;
            }
            if (node.type === 'heading') {
                const level = Math.min(Math.max(node.attrs?.level || 2, 1), 6);
                return `<h${level}>${this.parseTipTapContent(node.content)}</h${level}>`;
            }
            if (node.type === 'codeBlock' || node.type === 'code_block') {
                const rawCode = Array.isArray(node.content)
                    ? node.content.map((c: any) => c.text || '').join('')
                    : (node.text || '');
                const lang = node.attrs?.language ? ` class="language-${escapeHtml(node.attrs.language)}"` : '';
                return `<pre><code${lang}>${escapeHtml(rawCode)}</code></pre>`;
            }
            if (node.type === 'image' || node.type === 'image-block' || (node.attrs && node.attrs.src)) {
                const src = node.attrs.src || node.attrs.url || node.attrs.originalSrc;
                const alt = escapeHtml(node.attrs.alt || '');
                if (src) {
                    return `<img src="${src}" alt="${alt}" />`;
                }
            }
            if (node.type === 'blockquote') {
                return `<blockquote>${this.parseTipTap(node.content)}</blockquote>`;
            }
            if (node.type === 'table') {
                return `<table>${this.parseTipTap(node.content)}</table>`;
            }
            if (node.type === 'tableRow') {
                return `<tr>${this.parseTipTap(node.content)}</tr>`;
            }
            if (node.type === 'tableHeader') {
                return `<th>${this.parseTipTap(node.content)}</th>`;
            }
            if (node.type === 'tableCell') {
                return `<td>${this.parseTipTap(node.content)}</td>`;
            }
            if (node.type === 'text') {
                return this.parseTipTapContent([node]);
            }

            // Fallback for nested content in unknown blocks
            if (node.content && Array.isArray(node.content)) {
                const hasBlockChildren = node.content.some((child: any) => child && child.type !== 'text' && child.type !== 'hardBreak');
                if (hasBlockChildren) {
                    return `<div>${this.parseTipTap(node.content)}</div>`;
                } else {
                    return `<div>${this.parseTipTapContent(node.content)}</div>`;
                }
            }

            return '';
        }).join('');
    }

    private parseTipTapContent(content: any[]): string {
        if (!Array.isArray(content)) return '';
        return content.map(item => {
            if (!item) return '';
            if (item.type === 'text') {
                let text = escapeHtml(item.text || '');
                if (item.marks && Array.isArray(item.marks)) {
                    item.marks.forEach((mark: any) => {
                        if (mark.type === 'bold') text = `<b>${text}</b>`;
                        if (mark.type === 'italic') text = `<i>${text}</i>`;
                        if (mark.type === 'strike') text = `<s>${text}</s>`;
                        if (mark.type === 'underline') text = `<u>${text}</u>`;
                        if (mark.type === 'code') text = `<code>${text}</code>`;
                        if (mark.type === 'link') {
                            const href = escapeHtml(mark.attrs?.href || '#');
                            text = `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
                        }
                    });
                }
                return text;
            }
            if (item.type === 'hardBreak') return '<br/>';
            return '';
        }).join('');
    }
}
