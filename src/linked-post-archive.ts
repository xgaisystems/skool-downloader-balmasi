import fs from 'fs-extra';
import path from 'path';
import type { LinkedPost, PostComment, PostVideo, Resource } from './scraper.js';
import { summarizeVideoError, type Downloader } from './downloader.js';
import type { Logger } from './logger.js';
import { sanitizeName } from './utils.js';
import {
    POST_PAGE_FILE,
    formatVideoDuration,
    renderPostMarkdown,
    renderPostPage,
    type LinkedPostCommentView,
    type LinkedPostFile,
    type LinkedPostVideo,
    type LinkedPostView,
    type PostLinkResolver
} from './linked-posts.js';

// Larger images stay as files next to post.html instead of bloating it.
const MAX_EMBEDDED_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.svg': 'image/svg+xml'
};

export interface LinkedPostManifest {
    name: string;
    title: string;
    url: string;
    // The post page, relative to the lesson folder.
    page: string;
    incomplete: boolean;
    commentsCount: number;
    commentsSaved: number;
    commentsComplete: boolean;
    videos: number;
    videosDownloaded: number;
    files: number;
}

export interface LinkedPostVideoFailure {
    reason: string;
    videoUrl: string;
}

export interface SavedLinkedPost {
    view: LinkedPostView;
    manifest: LinkedPostManifest;
    videoFailures: LinkedPostVideoFailure[];
}

export interface SaveLinkedPostOptions {
    lessonDir: string;
    lessonTitle: string;
    downloader: Downloader;
    logger: Logger;
    skipVideos: boolean;
    // The resolver for obj:// links in a page saved in `fromDir`.
    linkResolver: (fromDir: string) => PostLinkResolver;
}

function flattenComments(comments: PostComment[]): PostComment[] {
    return comments.flatMap(c => [c, ...flattenComments(c.replies)]);
}

// localizeImages() points images at the lesson's assets/ folder. post.html
// gets them as data: URIs so the page is one file, or a path up to that
// folder when an image is missing or too large.
async function embedLocalImages(html: string, lessonDir: string, postDir: string): Promise<string> {
    const sources = [...new Set([...html.matchAll(/<img[^>]+src="(assets\/[^"]+)"/g)].map(m => m[1]!))];
    let result = html;
    for (const src of sources) {
        const filePath = path.join(lessonDir, decodeURIComponent(src));
        let replacement = path.relative(postDir, filePath).split(path.sep).map(encodeURIComponent).join('/');
        const type = IMAGE_TYPES[path.extname(filePath).toLowerCase()];
        try {
            const stats = await fs.stat(filePath);
            if (type && stats.size <= MAX_EMBEDDED_IMAGE_BYTES) {
                replacement = `data:${type};base64,${(await fs.readFile(filePath)).toString('base64')}`;
            }
        } catch {
            // Not downloaded: keep the relative path.
        }
        result = result.split(`src="${src}"`).join(`src="${replacement}"`);
    }
    return result;
}

// Saves a community post linked to a lesson in posts/<post-slug>/: its
// attachments and those of its comments in one folder, its videos and those of
// its comments, and post.html with the post and every comment. Returns what the
// lesson page shows of it. A failed download never throws: files keep their
// remote link and videos are reported in videoFailures.
export async function saveLinkedPost(post: LinkedPost, options: SaveLinkedPostOptions): Promise<SavedLinkedPost> {
    const { lessonDir, downloader, logger } = options;
    const postDirName = sanitizeName(post.name) || post.id;
    const folder = `posts/${postDirName}`;
    const postDir = path.join(lessonDir, 'posts', postDirName);
    await fs.ensureDir(postDir);

    // Members commonly upload files with the same name (image.png, resumen.pdf).
    const usedNames = new Set<string>([POST_PAGE_FILE]);
    const comments = flattenComments(post.comments);
    const videoPrefixes = new Map<PostComment, string>(comments.map((c, i) => [c, `comentario-${String(i + 1).padStart(2, '0')}-`]));
    const videoFileName = (prefix: string, i: number) => `${prefix}video-${String(i + 1).padStart(2, '0')}`;
    post.videos.forEach((_, i) => usedNames.add(`${videoFileName('', i)}.mp4`));
    comments.forEach(c => c.videos.forEach((_, i) => usedNames.add(`${videoFileName(videoPrefixes.get(c)!, i)}.mp4`)));

    const attachments: Resource[] = [...post.attachments, ...comments.flatMap(c => c.attachments)];
    const savedFiles = new Map<Resource, LinkedPostFile>();
    const fileJobs = attachments.map(attachment => {
        const name = attachment.file_name || attachment.title;
        let fileName = sanitizeName(name) || attachment.file_id || 'attachment';
        if (usedNames.has(fileName)) fileName = `${attachment.file_id}-${fileName}`;
        usedNames.add(fileName);
        return { attachment, name, fileName };
    });
    await Promise.all(fileJobs.map(async ({ attachment, name, fileName }) => {
        const isImage = !!attachment.file_content_type?.startsWith('image/');
        const filePath = path.join(postDir, fileName);
        try {
            if (!attachment.downloadUrl) throw new Error('no download link');
            await downloader.downloadAsset(attachment.downloadUrl, filePath);
            let dataUri: string | undefined;
            const type = IMAGE_TYPES[path.extname(fileName).toLowerCase()] ?? (isImage ? attachment.file_content_type : undefined);
            if (isImage && type && (await fs.stat(filePath)).size <= MAX_EMBEDDED_IMAGE_BYTES) {
                dataUri = `data:${type};base64,${(await fs.readFile(filePath)).toString('base64')}`;
            }
            savedFiles.set(attachment, { name, isImage, href: encodeURIComponent(fileName), dataUri });
        } catch (err) {
            logger.warn(`    ⚠️  Failed to download attachment "${name}" of post ${post.url}: ${String(err)}`);
            savedFiles.set(attachment, { name, isImage, href: attachment.downloadUrl || post.url });
        }
    }));
    const filesOf = (resources: Resource[]) => resources.map(r => savedFiles.get(r)!).filter(Boolean);

    // One at a time: each is a yt-dlp run with 16 fragment connections, and a
    // post can hold many.
    const videoFailures: LinkedPostVideoFailure[] = [];
    let videosDownloaded = 0;
    const saveVideos = async (videos: PostVideo[], prefix: string): Promise<LinkedPostVideo[]> => {
        const views: LinkedPostVideo[] = [];
        for (const [i, video] of videos.entries()) {
            const baseName = videoFileName(prefix, i);
            const duration = formatVideoDuration(video.durationMs);
            const label = `Vídeo ${i + 1}${duration ? ` · ${duration}` : ''}`;
            const fileName = `${baseName}.mp4`;
            const exists = await fs.pathExists(path.join(postDir, fileName));

            if (options.skipVideos || exists) {
                // downloadVideo() would skip an existing file too, without
                // needing a signed link.
                if (exists) videosDownloaded += 1;
                views.push({ label, href: exists ? encodeURIComponent(fileName) : undefined });
                continue;
            }
            if (!video.streamUrl) {
                videoFailures.push({ reason: 'Skool returned no playback data for this video', videoUrl: post.url });
                views.push({ label });
                continue;
            }
            try {
                await downloader.downloadVideo(video.streamUrl, postDir, baseName);
                videosDownloaded += 1;
                views.push({ label, href: encodeURIComponent(fileName) });
            } catch (err) {
                const reason = summarizeVideoError(err);
                logger.warn(`    ⚠️ Failed to download a video of post ${post.url}: ${reason}`);
                videoFailures.push({ reason, videoUrl: video.streamUrl });
                views.push({ label });
            }
        }
        return views;
    };

    const postVideos = await saveVideos(post.videos, '');
    const commentVideos = new Map<PostComment, LinkedPostVideo[]>();
    for (const comment of comments) {
        commentVideos.set(comment, await saveVideos(comment.videos, videoPrefixes.get(comment)!));
    }

    const lessonLinks = options.linkResolver(lessonDir);
    const pageLinks = options.linkResolver(postDir);
    const pageHtml = async (markdown: string) =>
        embedLocalImages(await downloader.localizeImages(renderPostMarkdown(markdown, pageLinks), lessonDir), lessonDir, postDir);

    const toCommentView = async (comment: PostComment): Promise<LinkedPostCommentView> => ({
        authorName: comment.authorName,
        createdAt: comment.createdAt,
        upvotes: comment.upvotes,
        pinned: comment.pinned,
        contentHtml: await pageHtml(comment.content),
        files: filesOf(comment.attachments),
        videos: commentVideos.get(comment) ?? [],
        videoLinks: comment.videoLinks,
        replies: await Promise.all(comment.replies.map(toCommentView))
    });

    const view: LinkedPostView = {
        title: post.title,
        url: post.url,
        authorName: post.authorName,
        createdAt: post.createdAt,
        upvotes: post.upvotes,
        incomplete: post.incomplete,
        contentHtml: await downloader.localizeImages(renderPostMarkdown(post.content, lessonLinks), lessonDir),
        files: filesOf(post.attachments),
        videos: postVideos,
        videoLinks: post.videoLinks,
        folder,
        commentsCount: post.commentsCount,
        commentsSaved: comments.length
    };

    await fs.writeFile(path.join(postDir, POST_PAGE_FILE), renderPostPage({
        ...view,
        contentHtml: await pageHtml(post.content),
        comments: await Promise.all(post.comments.map(toCommentView)),
        commentsComplete: post.commentsComplete,
        lessonTitle: options.lessonTitle,
        lessonHref: '../../index.html'
    }));

    return {
        view,
        videoFailures,
        manifest: {
            name: post.name,
            title: post.title,
            url: post.url,
            page: `${folder}/${POST_PAGE_FILE}`,
            incomplete: post.incomplete,
            commentsCount: post.commentsCount,
            commentsSaved: comments.length,
            commentsComplete: post.commentsComplete,
            videos: post.videos.length + comments.reduce((sum, c) => sum + c.videos.length, 0),
            videosDownloaded,
            files: attachments.length
        }
    };
}
