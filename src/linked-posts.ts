import { Marked } from 'marked';
import { escapeHtml, formatDate, formatDateTime } from './utils.js';

export interface LinkedPostFile {
    name: string;
    // Relative to the post's folder, or the remote link when the download failed.
    href: string;
    isImage: boolean;
    // Set for images small enough to embed in post.html.
    dataUri?: string;
}

export interface LinkedPostVideo {
    label: string;
    // Relative to the post's folder. Missing when the video was not downloaded.
    href?: string;
}

interface PostBodyView {
    authorName: string;
    createdAt?: string;
    upvotes: number;
    contentHtml: string;
    files: LinkedPostFile[];
    videos: LinkedPostVideo[];
    videoLinks: string[];
}

export interface LinkedPostCommentView extends PostBodyView {
    pinned: boolean;
    replies: LinkedPostCommentView[];
}

export interface LinkedPostView extends PostBodyView {
    title: string;
    url: string;
    incomplete?: boolean;
    // The post's folder, relative to the lesson folder (posts/<post-slug>).
    folder: string;
    commentsCount: number;
    commentsSaved: number;
}

export interface PostPageView extends LinkedPostView {
    comments: LinkedPostCommentView[];
    commentsComplete: boolean;
    lessonTitle: string;
    // The lesson page, relative to the post's folder.
    lessonHref: string;
}

export const POST_PAGE_FILE = 'post.html';

function isSafeUrl(url: string, schemes: string[]): boolean {
    try {
        return schemes.includes(new URL(url).protocol);
    } catch {
        return false;
    }
}

function isAbsoluteUrl(href: string) {
    return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

// Skool's editor stores lists as `[ul][li]one[li]two` (or `[ol]`) on one
// line, which Markdown prints as is.
function expandSkoolLists(markdown: string): string {
    return markdown
        .replace(/\[\/(?:ul|ol|li)\]/g, '')
        .replace(/\[(ul|ol)\]((?:\[li\][^\n]*)+)/g, (_match, kind: string, items: string) => {
            const lines = items.split('[li]').slice(1).map(item => item.trim()).filter(Boolean)
                .map((item, i) => `${kind === 'ol' ? `${i + 1}.` : '-'} ${item}`);
            return `\n\n${lines.join('\n')}\n\n`;
        });
}

// Turns a link to a lesson (obj://course/<lesson id>?cn=<course key>) into a
// local or Skool URL. Returns undefined to keep only the link text.
export type PostLinkResolver = (href: string) => string | undefined;

// Posts are written by any community member and end up on a page served from
// the same origin as the local progress API, so raw HTML and non-web URLs must
// not survive. Mentions arrive as links to obj://user/... and become plain text.
function createPostMarkdown(resolveLink?: PostLinkResolver) {
    return new Marked({
        gfm: true,
        breaks: true,
        renderer: {
            html(token) {
                return escapeHtml(token.text);
            },
            link(token) {
                const text = this.parser.parseInline(token.tokens);
                if (token.href.startsWith('obj://')) {
                    const resolved = token.href.startsWith('obj://course/') ? resolveLink?.(token.href) : undefined;
                    if (!resolved || (isAbsoluteUrl(resolved) && !isSafeUrl(resolved, ['http:', 'https:']))) return text;
                    const target = isAbsoluteUrl(resolved) ? ' target="_blank" rel="noopener noreferrer"' : '';
                    return `<a href="${escapeHtml(resolved)}"${target}>${text}</a>`;
                }
                if (!isSafeUrl(token.href, ['http:', 'https:', 'mailto:'])) return text;
                return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
            },
            image(token) {
                if (!isSafeUrl(token.href, ['http:', 'https:'])) return escapeHtml(token.text);
                return `<img src="${escapeHtml(token.href)}" alt="${escapeHtml(token.text)}" />`;
            }
        }
    });
}

export function renderPostMarkdown(markdown: string, resolveLink?: PostLinkResolver): string {
    return createPostMarkdown(resolveLink).parse(expandSkoolLists(markdown), { async: false });
}

export function formatVideoDuration(durationMs?: number): string {
    if (!durationMs || durationMs <= 0) return '';
    const total = Math.round(durationMs / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function encodeFolder(folder: string) {
    return folder.split('/').map(encodeURIComponent).join('/');
}

// A file or video href is relative to the post's folder; the lesson page sits
// one folder above it.
function fromLesson(folder: string, href: string) {
    return isAbsoluteUrl(href) ? href : `${encodeFolder(folder)}/${href}`;
}

function renderMeta(post: PostBodyView, withTime: boolean) {
    const date = post.createdAt ? (withTime ? formatDateTime(post.createdAt, false) : formatDate(post.createdAt)) : '';
    const parts = [post.authorName, date].filter(Boolean).map(escapeHtml);
    if (post.upvotes > 0) parts.push(`▲ ${post.upvotes}`);
    return parts.join(' · ');
}

function renderVideoLinks(links: string[]) {
    const safe = links.filter(link => isSafeUrl(link, ['http:', 'https:']));
    if (safe.length === 0) return '';
    return `<ul class="linked-post-files">${safe.map(link => `<li><a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">🔗 ${escapeHtml(link)}</a></li>`).join('')}</ul>`;
}

function renderLinkedPost(post: LinkedPostView): string {
    const images = post.files.filter(f => f.isImage);
    const others = post.files.filter(f => !f.isImage);
    const items = [
        ...post.videos.map(v => v.href
            ? `<li><a href="${escapeHtml(fromLesson(post.folder, v.href))}" target="_blank">🎬 ${escapeHtml(v.label)}</a></li>`
            : `<li>🎬 ${escapeHtml(v.label)} (no descargado)</li>`),
        ...others.map(f => `<li><a href="${escapeHtml(fromLesson(post.folder, f.href))}" download>📎 ${escapeHtml(f.name)}</a></li>`)
    ];
    const pageHref = `${encodeFolder(post.folder)}/${POST_PAGE_FILE}`;
    const commentsLabel = post.commentsSaved > 0
        ? `💬 Ver el post completo con sus ${post.commentsSaved} comentarios`
        : '💬 Ver el post completo';

    return `
        <article class="linked-post">
            <h4>${escapeHtml(post.title)}</h4>
            <div class="linked-post-meta">${renderMeta(post, false)} · <a href="${escapeHtml(post.url)}" target="_blank" rel="noopener noreferrer">Ver en Skool</a></div>
            ${post.incomplete ? '<p class="linked-post-warning">⚠️ No se pudo abrir este post durante la descarga: el texto puede estar recortado y faltar adjuntos y comentarios.</p>' : ''}
            <div class="content">${post.contentHtml}</div>
            ${images.map(f => `<a href="${escapeHtml(fromLesson(post.folder, f.href))}" target="_blank"><img src="${escapeHtml(fromLesson(post.folder, f.href))}" alt="${escapeHtml(f.name)}" /></a>`).join('')}
            ${items.length > 0 ? `<ul class="linked-post-files">${items.join('')}</ul>` : ''}
            ${renderVideoLinks(post.videoLinks)}
            <p class="linked-post-page"><a href="${escapeHtml(pageHref)}" target="_blank">${commentsLabel}</a></p>
        </article>`;
}

export function renderLinkedPosts(posts: LinkedPostView[]): string {
    if (posts.length === 0) return '';
    return `
        <section class="linked-posts">
            <h3>Posts de la comunidad</h3>
            ${posts.map(renderLinkedPost).join('')}
        </section>`;
}

// The line for the lesson's "Resources / Attachments" list.
export function renderLinkedPostSource(post: LinkedPostView): string {
    const href = `${encodeFolder(post.folder)}/${POST_PAGE_FILE}`;
    const comments = post.commentsSaved > 0 ? ` (post y ${post.commentsSaved} comentarios)` : ' (post)';
    return `<li><a href="${escapeHtml(href)}" target="_blank">Fuente: ${escapeHtml(post.title)}${comments}</a></li>`;
}

// Inside post.html every href is already relative to the post's folder.
function renderBody(body: PostBodyView) {
    const images = body.files.filter(f => f.isImage);
    const others = body.files.filter(f => !f.isImage);
    return `
        <div class="content">${body.contentHtml}</div>
        ${body.videos.map(v => v.href
            ? `<figure class="post-video"><video controls preload="metadata" src="${escapeHtml(v.href)}"></video><figcaption>${escapeHtml(v.label)}</figcaption></figure>`
            : `<p class="post-missing">🎬 ${escapeHtml(v.label)}: no descargado.</p>`).join('')}
        ${images.map(f => `<a href="${escapeHtml(f.href)}" target="_blank"><img src="${escapeHtml(f.dataUri ?? f.href)}" alt="${escapeHtml(f.name)}" /></a>`).join('')}
        ${others.length > 0 ? `<ul class="linked-post-files">${others.map(f => `<li><a href="${escapeHtml(f.href)}" download>📎 ${escapeHtml(f.name)}</a></li>`).join('')}</ul>` : ''}
        ${renderVideoLinks(body.videoLinks)}`;
}

function renderComment(comment: LinkedPostCommentView): string {
    return `
        <div class="comment">
            <div class="comment-meta">${comment.pinned ? '📌 ' : ''}${renderMeta(comment, true)}</div>
            ${renderBody(comment)}
            ${comment.replies.length > 0 ? `<div class="replies">${comment.replies.map(renderComment).join('')}</div>` : ''}
        </div>`;
}

// A page of its own for one post and all its comments. It carries no script
// and only data: URIs and files next to it, so it can be opened anywhere.
export function renderPostPage(post: PostPageView): string {
    const missing = post.commentsCount > post.commentsSaved
        ? `<p class="post-warning">⚠️ Skool indica ${post.commentsCount} comentarios y se guardaron ${post.commentsSaved}${post.commentsComplete ? ' (los demás pueden estar borrados)' : ': falló la descarga de una parte'}.</p>`
        : (!post.commentsComplete ? '<p class="post-warning">⚠️ No se pudieron descargar todos los comentarios.</p>' : '');

    return `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(post.title)}</title>
    <style>${POST_PAGE_CSS}</style>
</head>
<body>
    <div class="page">
        <div class="breadcrumb"><a href="${escapeHtml(post.lessonHref)}">← ${escapeHtml(post.lessonTitle)}</a></div>
        <article class="post">
            <h1>${escapeHtml(post.title)}</h1>
            <div class="post-meta">${renderMeta(post, true)} · <a href="${escapeHtml(post.url)}" target="_blank" rel="noopener noreferrer">Ver en Skool</a></div>
            ${post.incomplete ? '<p class="post-warning">⚠️ No se pudo abrir este post durante la descarga: el texto puede estar recortado y faltar adjuntos y comentarios.</p>' : ''}
            ${renderBody(post)}
        </article>
        <section class="comments">
            <h2>Comentarios (${post.commentsSaved})</h2>
            ${missing}
            ${post.comments.map(renderComment).join('')}
        </section>
    </div>
</body>
</html>
`;
}

const POST_PAGE_CSS = `
    :root {
        --panel: #ffffff;
        --panel-2: #f6f7fb;
        --text: #14161d;
        --muted: #5b6271;
        --accent: #3b82f6;
        --ring: rgba(20,22,29,0.08);
    }
    * { box-sizing: border-box; }
    body {
        margin: 0;
        font-family: "Space Grotesk", "Manrope", "Segoe UI", sans-serif;
        background: linear-gradient(160deg, #fdfdfd 0%, #eff2fb 100%);
        color: var(--text);
        line-height: 1.7;
    }
    .page { max-width: 860px; margin: 40px auto 80px; padding: 0 16px; }
    .breadcrumb { margin-bottom: 16px; }
    a { color: var(--accent); }
    .breadcrumb a { text-decoration: none; font-weight: 600; }
    .post, .comments {
        background: var(--panel);
        border: 1px solid var(--ring);
        border-radius: 16px;
        padding: 24px;
        margin-bottom: 20px;
    }
    h1 { margin: 0 0 6px 0; font-size: 1.7rem; line-height: 1.25; }
    h2 { margin: 0 0 14px 0; font-size: 1.25rem; }
    .post-meta, .comment-meta { font-size: 0.88em; color: var(--muted); margin-bottom: 12px; }
    .post-warning { font-weight: 600; }
    .post-missing { color: var(--muted); font-size: 0.92em; }
    .content { overflow-wrap: anywhere; }
    img { max-width: 100%; height: auto; display: block; margin: 10px 0; border-radius: 8px; }
    .post-video { margin: 14px 0; }
    .post-video video { width: 100%; max-height: 80vh; background: #020617; border-radius: 10px; }
    .post-video figcaption { font-size: 0.85em; color: var(--muted); }
    .linked-post-files { list-style: none; padding: 0; margin: 12px 0 0 0; display: grid; gap: 6px; }
    .comment { border-top: 1px solid var(--ring); padding: 14px 0 4px 0; }
    .comment .content p { margin: 0 0 8px 0; }
    .replies { margin-left: 18px; padding-left: 14px; border-left: 3px solid var(--panel-2); }
    .replies .comment:first-child { border-top: none; }
`;

export const LINKED_POSTS_CSS = `
    .linked-posts { margin-top: 28px; }
    .linked-posts h3 { margin: 0 0 12px 0; color: var(--accent); }
    .linked-post {
        background: var(--panel-2);
        padding: 18px;
        border-radius: 14px;
        border: 1px solid var(--ring);
        margin-bottom: 14px;
    }
    .linked-post h4 { margin: 0 0 4px 0; font-size: 1.1em; }
    .linked-post-meta { font-size: 0.85em; opacity: 0.75; margin-bottom: 12px; }
    .linked-post-warning { font-size: 0.9em; font-weight: 600; }
    .linked-post img { max-width: 100%; height: auto; display: block; margin: 10px 0; border-radius: 8px; }
    .linked-post-files { list-style: none; padding: 0; margin: 12px 0 0 0; display: grid; gap: 6px; }
    .linked-post-page { margin: 12px 0 0 0; font-weight: 600; }
`;
