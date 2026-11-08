import http, { type IncomingMessage, type ServerResponse } from 'http';
import fs from 'fs';
import path from 'path';
import { escapeHtml, resolveDownloadsDir } from './utils.js';
import { PROGRESS_SERVER_PORT } from './progress-sync.js';

export interface ServerOptions {
    port?: number;
    // 127.0.0.1 unless asked otherwise: the server hands out every downloaded
    // course and lets any caller rewrite progress.json.
    host?: string;
    rootDir?: string;
    onReady?: (info: { port: number; url: string; localIp: string }) => void;
}

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.m4a': 'audio/mp4',
    '.vtt': 'text/vtt; charset=utf-8',
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.ts': 'video/mp2t',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
};

// Shown at / so the server has an entry page without knowing the community
// names: every folder of the downloads root with an index.html is one.
function renderCommunityList(rootDir: string): string {
    let communities: string[] = [];
    try {
        communities = fs.readdirSync(rootDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && fs.existsSync(path.join(rootDir, entry.name, 'index.html')))
            .map(entry => entry.name)
            .sort((a, b) => a.localeCompare(b));
    } catch {
        // An unreadable root renders the empty list.
    }
    const items = communities
        .map(name => `<li><a href="/${encodeURIComponent(name)}/index.html">${escapeHtml(name)}</a></li>`)
        .join('');
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Skool Downloader</title>` +
        `<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 16px;color:#0f172a}a{color:#2563eb}li{margin:8px 0;font-size:1.1rem}</style></head>` +
        `<body><h1>Comunidades descargadas</h1>${items ? `<ul>${items}</ul>` : '<p>Todavía no hay ninguna comunidad descargada.</p>'}</body></html>`;
}

export function startServer(options: ServerOptions = {}) {
    const defaultPort = options.port || PROGRESS_SERVER_PORT;
    const host = options.host || '127.0.0.1';
    const rootDir = path.resolve(options.rootDir || resolveDownloadsDir());
    const progressFilePath = path.join(rootDir, 'progress.json');

    // Active SSE client connections
    const sseClients = new Set<ServerResponse>();

    function getProgressData(): Record<string, boolean> {
        try {
            if (fs.existsSync(progressFilePath)) {
                const raw = fs.readFileSync(progressFilePath, 'utf-8');
                return JSON.parse(raw);
            }
        } catch {
            // Ignore parse errors, fallback to empty
        }
        return {};
    }

    function saveProgressData(newData: Record<string, boolean>, replace: boolean = false): Record<string, boolean> {
        let finalData: Record<string, boolean>;
        if (replace) {
            finalData = { ...newData };
        } else {
            const current = getProgressData();
            finalData = { ...current, ...newData };
        }
        try {
            const tmpFile = `${progressFilePath}.tmp.${Date.now()}`;
            fs.writeFileSync(tmpFile, JSON.stringify(finalData, null, 2), 'utf-8');
            fs.renameSync(tmpFile, progressFilePath);
        } catch (err) {
            console.error('Failed to save progress to file:', err);
        }

        // Notify all SSE clients
        const payload = JSON.stringify({ type: 'progress', data: finalData });
        for (const client of sseClients) {
            try {
                client.write(`data: ${payload}\n\n`);
            } catch {
                sseClients.delete(client);
            }
        }

        return finalData;
    }

    const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
        // Pages opened as file:// send Origin: null and need CORS to reach the
        // API. Pages served from here are same-origin and need nothing. Any
        // other origin is a website in the browser and gets no access, which
        // "*" used to grant to progress.json and every downloaded file.
        if (req.headers.origin === 'null') {
            res.setHeader('Access-Control-Allow-Origin', 'null');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.setHeader('Vary', 'Origin');
        }

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        const urlParts = (req.url || '/').split('?');
        const reqPath = urlParts[0];

        // API Endpoint: GET /api/progress
        if (reqPath === '/api/progress' && req.method === 'GET') {
            const data = getProgressData();
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-cache'
            });
            res.end(JSON.stringify(data));
            return;
        }

        // API Endpoint: POST /api/progress
        if (reqPath === '/api/progress' && req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
                body += chunk;
                if (body.length > 5 * 1024 * 1024) {
                    req.destroy();
                }
            });
            req.on('end', () => {
                try {
                    const parsed = JSON.parse(body || '{}');
                    let updated: Record<string, boolean>;

                    if (parsed.delta && typeof parsed.delta === 'object' && parsed.delta.lessonId) {
                        const current = getProgressData();
                        if (parsed.delta.isDone) {
                            current[parsed.delta.lessonId] = true;
                        } else {
                            delete current[parsed.delta.lessonId];
                        }
                        updated = saveProgressData(current, true);
                    } else if (parsed.lessonId && typeof parsed.lessonId === 'string') {
                        const current = getProgressData();
                        if (parsed.isDone) {
                            current[parsed.lessonId] = true;
                        } else {
                            delete current[parsed.lessonId];
                        }
                        updated = saveProgressData(current, true);
                    } else {
                        const dataToSave = (parsed.data && typeof parsed.data === 'object') ? parsed.data : parsed;
                        updated = saveProgressData(dataToSave, true);
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ success: true, count: Object.keys(updated).length, data: updated }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                }
            });
            return;
        }

        // API Endpoint: GET /api/events (SSE)
        if (reqPath === '/api/events' && req.method === 'GET') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });

            // Send initial handshake
            res.write(`: connected\n\n`);
            // Send current progress immediately
            res.write(`data: ${JSON.stringify({ type: 'progress', data: getProgressData() })}\n\n`);

            sseClients.add(res);

            req.on('close', () => {
                sseClients.delete(res);
            });
            return;
        }

        // Static files handler
        let safePath: string;
        try {
            safePath = path.normalize(decodeURIComponent(reqPath)).replace(/^(\.\.[\/\\])+/, '');
        } catch {
            res.writeHead(400);
            res.end('Bad Request');
            return;
        }

        let fullPath = path.join(rootDir, safePath);

        // Security check: must stay within rootDir
        if (fullPath !== rootDir && !fullPath.startsWith(rootDir + path.sep)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        // If directory, look for index.html
        if (fs.existsSync(fullPath)) {
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    fullPath = path.join(fullPath, 'index.html');
                }
            } catch {
                res.writeHead(500);
                res.end('Internal Server Error');
                return;
            }
        }

        if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
            if (reqPath === '/') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
                res.end(renderCommunityList(rootDir));
                return;
            }
            res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>404 Not Found</title></head><body><h1>404 - Not Found</h1><p>The requested file does not exist: <code>${escapeHtml(safePath)}</code></p><p><a href="/">Go to the list of communities</a></p></body></html>`);
            return;
        }

        const ext = path.extname(fullPath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const stat = fs.statSync(fullPath);
        const fileSize = stat.size;

        // Support HTTP Range requests (crucial for video scrubbing and seeking)
        const range = req.headers.range;
        if (range && (ext === '.mp4' || ext === '.webm' || ext === '.m4a')) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

            if (start >= fileSize || end >= fileSize) {
                res.writeHead(416, {
                    'Content-Range': `bytes */${fileSize}`
                });
                res.end();
                return;
            }

            const chunkSize = (end - start) + 1;
            const fileStream = fs.createReadStream(fullPath, { start, end });

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': contentType
            });

            fileStream.pipe(res);
            return;
        }

        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes',
            'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
        });

        fs.createReadStream(fullPath).pipe(res);
    });

    let currentPort = defaultPort;

    function listen(portToTry: number): Promise<{ port: number; url: string }> {
        return new Promise((resolve, reject) => {
            server.once('error', (err: NodeJS.ErrnoException) => {
                // No silent move to the next port: pages opened as file://
                // only ever talk to PROGRESS_SERVER_PORT, so they would stop
                // syncing without saying why.
                if (err.code === 'EADDRINUSE') {
                    reject(new Error(
                        `Port ${portToTry} is already in use, probably by another "skool serve". ` +
                        `Stop it, or pick another port with --port (pages opened as file:// only sync with port ${PROGRESS_SERVER_PORT}).`
                    ));
                } else {
                    reject(err);
                }
            });

            server.listen(portToTry, host, () => {
                currentPort = portToTry;
                const url = `http://localhost:${currentPort}/`;
                resolve({ port: currentPort, url });
            });
        });
    }

    return {
        server,
        start: async () => {
            const info = await listen(currentPort);
            if (options.onReady) {
                options.onReady({ port: info.port, url: info.url, localIp: 'localhost' });
            }
            return info;
        },
        close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    };
}
