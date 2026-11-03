// Browser-side code shared by every generated page (lesson, course index,
// group index) that shows "done" ticks. Progress lives in localStorage, is
// mirrored to window.name so it survives file:// navigation, and is synced
// with `skool serve` through /api/progress and /api/events.

// The port pages opened as file:// talk to. Pages opened through the server
// use their own origin instead, so `skool serve --port` only affects file://.
export const PROGRESS_SERVER_PORT = 3100;

const RUNTIME_JS = `
    const STORAGE_KEY = 'cerebro_completed_lessons';
    const isHttp = location.protocol.startsWith('http');
    const API_BASE = isHttp ? location.origin : 'http://127.0.0.1:${PROGRESS_SERVER_PORT}';
    const API_URL = API_BASE + '/api/progress';
    const EVENTS_URL = API_BASE + '/api/events';

    function getCompleted() {
        try {
            const local = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            if (location.protocol === 'file:' && window.name) {
                try {
                    const w = JSON.parse(window.name);
                    if (w && w.key === STORAGE_KEY && w.data) {
                        return Object.assign({}, local, w.data);
                    }
                } catch (e) {}
            }
            return local;
        } catch (e) {
            return {};
        }
    }

    function saveCompleted(data, broadcast) {
        if (broadcast === undefined) broadcast = true;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
        try { window.name = JSON.stringify({ key: STORAGE_KEY, data: data }); } catch (e) {}

        if (broadcast) {
            try {
                if (window.BroadcastChannel) {
                    const bc = new BroadcastChannel('cerebro_progress');
                    bc.postMessage({ type: 'sync', data: data });
                    bc.close();
                }
            } catch (e) {}
            fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            }).catch(() => {});
        }
    }

    // The same page on the local server. Downloads are served from the
    // downloads/ folder, so the part of the path after it is the server path;
    // a page saved anywhere else links to the server's list of communities.
    function serverPageUrl() {
        const marker = '/downloads/';
        const p = location.pathname;
        const i = p.lastIndexOf(marker);
        return 'http://localhost:${PROGRESS_SERVER_PORT}/' + (i >= 0 ? p.slice(i + marker.length) : '');
    }

    function showOfflinePill() {
        if (location.protocol !== 'file:' || document.getElementById('syncPill')) return;
        const pill = document.createElement('div');
        pill.id = 'syncPill';
        pill.className = 'sync-pill is-disconnected';
        pill.title = 'Para sincronización automática en tiempo real, ejecuta: npm run serve';
        const dot = document.createElement('span');
        dot.className = 'sync-dot';
        const text = document.createElement('span');
        text.id = 'syncText';
        text.textContent = 'Modo local (file://)';
        const link = document.createElement('a');
        link.href = serverPageUrl();
        link.target = '_blank';
        link.textContent = 'Abrir en servidor ↗';
        pill.append(dot, text, ' ', link);
        document.body.appendChild(pill);
    }

    function startProgressSync(render) {
        const apply = (data) => { saveCompleted(data, false); render(data); };
        const pull = () => fetch(API_URL)
            .then(res => res.json())
            .then(data => {
                if (data && typeof data === 'object') apply(data);
                return true;
            });

        window.addEventListener('storage', (e) => { if (e.key === STORAGE_KEY) render(getCompleted()); });

        try {
            if (window.BroadcastChannel) {
                const bc = new BroadcastChannel('cerebro_progress');
                bc.onmessage = (e) => {
                    if (e.data && e.data.type === 'sync' && e.data.data) apply(e.data.data);
                };
            }
        } catch (e) {}

        // Carries progress to the next file:// page, where localStorage may
        // be per-file.
        document.addEventListener('click', (e) => {
            const link = e.target.closest('a');
            if (link && link.getAttribute('href') && !link.getAttribute('href').startsWith('http')) {
                try { window.name = JSON.stringify({ key: STORAGE_KEY, data: getCompleted() }); } catch (err) {}
            }
        });

        showOfflinePill();
        pull().then(() => {
            const pill = document.getElementById('syncPill');
            if (pill) {
                pill.className = 'sync-pill is-connected';
                const txt = document.getElementById('syncText');
                if (txt) txt.textContent = 'Sincronizado en vivo';
                pill.title = 'Sincronización en vivo activa con el servidor local';
            }
        }).catch(() => {});

        try {
            const es = new EventSource(EVENTS_URL);
            es.onmessage = (e) => {
                try {
                    const payload = JSON.parse(e.data);
                    if (payload && payload.type === 'progress' && payload.data) apply(payload.data);
                } catch (err) {}
            };
        } catch (e) {}

        window.addEventListener('pageshow', () => render(getCompleted()));
        window.addEventListener('focus', () => {
            render(getCompleted());
            pull().catch(() => {});
        });

        render(getCompleted());
    }
`;

/**
 * Wraps a page's own progress code with the shared runtime. `pageJs` runs in
 * the same closure, so it can use getCompleted/saveCompleted, and it must end
 * by calling startProgressSync(render) with the function that paints the
 * page for a given progress map.
 *
 * regenerate-index.ts finds and replaces this block in saved lesson pages by
 * the STORAGE_KEY line, so that line must stay in the runtime.
 */
export function renderProgressScript(pageJs: string): string {
    return `<script>
(function() {
${RUNTIME_JS}
${pageJs}
})();
</script>`;
}

export function renderLessonProgressScript(): string {
    return renderProgressScript(`
    const btn = document.getElementById('lessonTickBtn');
    if (!btn) return;
    const lessonId = btn.getAttribute('data-lesson-id');

    function render(data) {
        const isDone = !!data[lessonId];
        btn.classList.toggle('is-completed', isDone);
        btn.setAttribute('aria-pressed', isDone ? 'true' : 'false');
        btn.setAttribute('title', isDone ? 'Completada (clic para desmarcar)' : 'Marcar como realizada');
    }

    btn.addEventListener('click', () => {
        const data = getCompleted();
        if (btn.classList.contains('is-completed')) delete data[lessonId];
        else data[lessonId] = true;
        saveCompleted(data, true);
        render(data);
    });

    startProgressSync(render);
`);
}
