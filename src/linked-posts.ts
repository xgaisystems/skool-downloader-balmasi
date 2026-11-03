import { Marked } from 'marked';
import { escapeHtml, formatDate } from './utils.js';

export interface LinkedPostFile {
    name: string;
    href: string;
    isImage: boolean;
}

export interface LinkedPostView {
    title: string;
    url: string;
    authorName: string;
    createdAt?: string;
    contentHtml: string;
    incomplete?: boolean;
    files: LinkedPostFile[];
}

function isSafeUrl(url: string, schemes: string[]): boolean {
    try {
        return schemes.includes(new URL(url).protocol);
    } catch {
        return false;
    }
}

// Posts are written by any community member and end up on a page served from
// the same origin as the local progress API, so raw HTML and non-web URLs must
// not survive. Mentions arrive as links to obj://user/... and become plain text.
const postMarkdown = new Marked({
    gfm: true,
    breaks: true,
    renderer: {
        html(token) {
            return escapeHtml(token.text);
        },
        link(token) {
            const text = this.parser.parseInline(token.tokens);
            if (!isSafeUrl(token.href, ['http:', 'https:', 'mailto:'])) return text;
            return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
        },
        image(token) {
            if (!isSafeUrl(token.href, ['http:', 'https:'])) return escapeHtml(token.text);
            return `<img src="${escapeHtml(token.href)}" alt="${escapeHtml(token.text)}" />`;
        }
    }
});

export function renderPostMarkdown(markdown: string): string {
    return postMarkdown.parse(markdown, { async: false });
}

function renderLinkedPost(post: LinkedPostView): string {
    const date = post.createdAt ? formatDate(post.createdAt) : '';
    const meta = [post.authorName, date].filter(Boolean).map(escapeHtml).join(' · ');
    const images = post.files.filter(f => f.isImage);
    const others = post.files.filter(f => !f.isImage);

    return `
        <article class="linked-post">
            <h4>${escapeHtml(post.title)}</h4>
            <div class="linked-post-meta">${meta} · <a href="${escapeHtml(post.url)}" target="_blank" rel="noopener noreferrer">Ver en Skool</a></div>
            ${post.incomplete ? '<p class="linked-post-warning">⚠️ No se pudo abrir este post durante la descarga: el texto puede estar recortado y faltar adjuntos.</p>' : ''}
            <div class="content">${post.contentHtml}</div>
            ${images.map(f => `<a href="${escapeHtml(f.href)}" target="_blank"><img src="${escapeHtml(f.href)}" alt="${escapeHtml(f.name)}" /></a>`).join('')}
            ${others.length > 0 ? `<ul class="linked-post-files">${others.map(f => `<li><a href="${escapeHtml(f.href)}" download>📎 ${escapeHtml(f.name)}</a></li>`).join('')}</ul>` : ''}
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
`;
