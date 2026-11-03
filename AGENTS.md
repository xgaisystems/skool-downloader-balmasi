# Skool Downloader - Developer Onboarding

## Project Goal & Context
The goal of this project is to provide a robust, platform-independent tool for creating local, offline backups of Skool.com courses. This includes downloading video content, localizing images, and generating a navigable HTML structure that mirrors the online classroom.

## Technical Architecture

### Core Tech Stack
- **TypeScript / Node.js**: Modern ESM environment.
- **Playwright**: Used for scraping and the initial manual authentication flow.
- **yt-dlp**: Handled via `yt-dlp-wrap`. It's downloaded on first run into a per-user cache folder (`resolveCacheDir()` in `src/downloader.ts`, override with `SKOOL_DOWNLOADER_CACHE_DIR`) to avoid system-wide installations. It is deliberately not stored under the current directory or the package root. The binary is kept current automatically; see **Keeping yt-dlp current** below.
- **Axios**: For direct asset (image) downloads.

### Key Technical Strategies
1. **Source of Truth (`__NEXT_DATA__`)**:
   Instead of fragile DOM scraping, the tool extracts the `__NEXT_DATA__` JSON block from Skool's page source. This contains the structured course hierarchy, lesson metadata, and direct video links.
2. **Manual Authentication**:
   A script (`npm run login`) opens a browser for manual login, then captures the `storage_state.json`. 
3. **Cookie Conversion**:
   The tool automatically converts Playwright's JSON cookies into the **Netscape format** (`cookies.txt`) required by `yt-dlp` to access private course videos.
4. **Rich Text Parsing**:
   Skool uses TipTap/ProseMirror for lesson content. The scraper includes a parser (`parseTipTap`) to convert the stringified JSON content back into clean, localizable HTML.
5. **Asset Localization**:
   The `Downloader` class identifies `<img>` tags, downloads the images into a local `assets/` folder, and rewrites the HTML sources before saving.
6. **Native Video Extraction**:
   Skool's native Mux player requires a "play" click to generate authenticated HLS manifest URLs. The scraper simulates this interaction and monitors performance entries to extract the signed `.m3u8` link.
7. **Resource/Attachment Downloads**:
   Course attachments (PDFs, DOCX, etc.) are downloaded using direct API calls to `https://api2.skool.com/files/{file_id}/download-url?expire=28800`. This is more reliable than DOM interaction and returns signed CloudFront URLs for downloading.
8. **Community Posts Linked to a Lesson**:
   Cards under a lesson body are posts pinned to it. They are listed in the lesson's `pageProps.pinnedPosts`, which truncates the text at `metadata.contentLimit` and omits `attachmentsData`, so `extractLinkedPosts()` opens each post page (`postTree.post`) and only falls back to the partial copy, flagged as incomplete, if that fails. Content is Markdown written by any member: `src/linked-posts.ts` escapes raw HTML and drops non-web URLs, and must keep doing so because the page shares an origin with the local progress API. Attachments come from `metadata.read_url` and are stored in `posts/<post-slug>/` inside the lesson. Comments and videos attached to posts are not downloaded. Visits are spaced because bursts of navigation get a CloudFront 403 for the whole site.
9. **Keeping yt-dlp current**:
   A pinned yt-dlp rots, because its value is almost entirely in extractors that break when a video host changes (issue #14). `Downloader.init()` reads the installed version, which is a release date, and if it is older than `STALE_AFTER_DAYS` it compares against the newest GitHub release and installs it. A stamp file (`.yt-dlp-check.json`) limits this to one check per day; `init()` is memoised, so it is also at most once per run. Three rules matter when changing this code:
   - The update **blocks** the run instead of happening in the background. A background refresh would leave the current run on the binary that is already broken, which is the failure being fixed.
   - A download is written to a `.tmp` path and executed there before it is renamed into place. `YTDlpWrap.downloadFromGithub` is not used: it writes the response body before checking the status code, and attaches no error handler to the write stream, so a 404 or a read-only folder yields a corrupt binary or an uncaught exception. `downloadFile()` in `src/downloader.ts` replaces it.
   - A failed update must never fail a download. Everything except an unusable binary is caught, logged and continued past.

   The copy being replaced is kept as `yt-dlp.prev` for `skool update --rollback`. `SKOOL_NO_YTDLP_UPDATE=1` switches the automatic check off.
10. **High-Performance Downloads**:
   The downloader is optimized with `-N 16` for parallel fragment fetching and `ffmpeg` post-processing (`+faststart`) for instant in-browser playback.
11. **ffmpeg Fallbacks**:
   `findFfmpegCandidates()` collects `SKOOL_FFMPEG_PATH`, the bundled `ffmpeg-static` and the one on `PATH`, runs `-version` on each (dropping any that does not run, and duplicates by real path), and orders them newest version first, with `SKOOL_FFMPEG_PATH` always leading; nightly builds without a release number go after numbered ones. With none usable, the CLI (`ensureFfmpeg()`, before any download) warns and, in a TTY, offers `installBundledFfmpeg()`, which runs ffmpeg-static's own `install.js` to fetch the build for the OS/arch; without a TTY it prints the install hints and exits 1. The bundled build (ffmpeg-static 5.3.0, ffmpeg 7.0.2) segfaults in its MPEG-TS demuxer on some Loom HLS streams, even when only reading them; yt-dlp then reports `ERROR: Postprocessing:` followed by an ffmpeg progress line, not the crash. `downloadVideo()` retries a postprocessing failure with each other ffmpeg and finally with `-f b`, the best format that already holds video and audio (Loom's `http-transcoded` mp4 at full resolution), which needs no merge. Leftovers of a failed attempt (`.fhls-raw-*`, `.temp.mp4`, `.part`) are deleted before each retry and after giving up. Other failures are not retried. npm 12+ skips install scripts unless they are listed in `allowScripts` in `package.json`; `ffmpeg-static` must stay listed there (its version is part of the key) or a fresh install has no bundled binary.
12. **Failures Are Reported, Not Swallowed**:
   A video that fails used to be a warning and the lesson was counted as completed. Now each lesson task records failures (`LessonFailure`, kind `video` or `lesson`) and throws after saving whatever it could, so both task renderers show it as failed. `runConcurrent()` catches per task so one failure never stops the rest. `DownloadSummary` carries `failedVideos` and the `failures` list, `lesson.json` stores `videoError`, and `.download-failures.json` is written next to the course (removed after a full clean run). In interactive mode the logger queues warnings while a task renderer owns the terminal (`deferredLogs` in `src/cli.ts`), because both renderers redraw over anything printed meanwhile; the queue is printed when the run ends.
13. **Which Courses Are Locked**:
   `filterAccessibleCourses()` trusts `metadata.hasAccess` and only falls back to `privacy > 0` when Skool leaves `hasAccess` out. Gated courses keep `privacy: 1` for members who unlocked them, so treating `privacy` as "locked" skipped every course of such communities and multi-course downloads saved nothing.
14. **Interrupting a Download**:
   `registerShutdownHandlers()` in `src/index.ts` regenerates the course and group index on SIGINT/SIGTERM and exits with 130/143. It goes through `indexLimit`/`groupIndexLimit` (after clearing their queues) so it never writes `index.html.tmp` at the same time as a regular regeneration. Nothing else may call `process.exit` on SIGINT during a download: Listr runs with `registerSignalListeners: false` and the multi-column renderer only stops drawing.
15. **Asset Downloads**:
   `downloadAsset()` streams into `<file>.part` with `pipeline()` and renames at the end. `pipe()` does not forward a response error to the file, so a dropped connection used to leave the promise pending forever and hang the lesson and every course queued after it; and a partial file at the final path has a non-zero size, so later runs skipped it as complete. axios' `timeout` is an idle timeout on the socket in Node, so it also aborts a body that stops arriving.
16. **Progress Tracking and the Local Server**:
   Lesson, course and community pages carry a "done" tick. The browser code is generated in one place, `src/progress-sync.ts`: a shared runtime (localStorage, a `window.name` mirror for `file://` navigation, BroadcastChannel, and the `/api/progress` + `/api/events` SSE endpoints of `skool serve`) plus a small page-specific `render(data)`. A lesson's id is `<course folder>/<relative path of its index.html>`. `regenerateIndex()` swaps the script of saved lesson pages for the current one, located by its `STORAGE_KEY` line, but only when `patchLessons` is on: the regeneration that runs after every downloaded lesson passes `false`, otherwise each lesson finished rewrote every lesson page of the course. `src/server.ts` serves `downloads/` on `127.0.0.1:${PROGRESS_SERVER_PORT}` (3100) by default and answers CORS only for `Origin: null`, i.e. `file://` pages; a busy port is an error rather than a silent move, because `file://` pages only know `PROGRESS_SERVER_PORT`. Anything rendered from Skool data into these pages must be escaped: they share an origin with the progress API.
17. **Being Gentle with Skool**:
   Skool detects automated traffic and can cut an account's access. Keep lesson concurrency modest, keep the delays between navigations (`POST_NAVIGATION_DELAY_MS`, the waits in `extractLessonData()`), and never test against skool.com in loops: stub `Scraper`/`Downloader` methods for orchestration tests and use a local HTTP server for download tests.

## Project Structure
- `src/auth.ts`: Handles the manual login flow and cookie conversion.
- `src/scraper.ts`: Navigates the course tree and parses lesson metadata from Next.js state.
- `src/downloader.ts`: Wrapper for `yt-dlp` and logic for image localization and resource downloads.
- `src/cli.ts`: Interactive CLI entry point (login, download course, download multiple courses, download single lesson, serve, regenerate index, update yt-dlp). Runs lesson downloads concurrently with per-lesson status: Listr2 when the lessons fit the terminal, a multi-column view (`runMultiColumnTasks`) when they do not. Prints the failure summary after each course.
- `src/index.ts`: Core download orchestrator. Handles course parsing, output path resolution, lesson processing, and manifest/index generation. Exposes callbacks + task runner hooks for the CLI.
- **Single Lesson Extraction**: The tool detects `?md=` or `?lesson=` in the input URL to download only a specific lesson instead of the entire course, and reports the exact destination path.
- **Native Video Handling**: Automates interaction with the Mux player to capture signed tokens.
- **Resource Downloads**: Uses direct API calls to fetch signed download URLs for attachments, stored in `resources/` folder within each lesson.
- `src/linked-posts.ts`: Sanitised Markdown rendering and the HTML of the community posts embedded in a lesson page.
- `src/progress-sync.ts`: Browser code for the "done" ticks shared by all generated pages, and `PROGRESS_SERVER_PORT`.
- `src/server.ts`: `skool serve`, the local static server for `downloads/` with the progress API and SSE.
- `bin/skool.js`: The published CLI shim. The `yt-dlp` binary lives in the per-user cache folder, not here.
- `src/utils.ts`: Shared utilities including European date and time formatting (`dd/mm/aaaa`).

### Date Formatting Standard (European Format: dd/mm/aaaa)
All user-facing dates across the codebase (HTML index/course templates, chips, course manifests display, CLI output, and log messages) MUST strictly follow the European format: `dd/mm/aaaa` (e.g., `01/10/2026`), or `dd/mm/aaaa HH:mm:ss` when including timestamps with time.
- Always use the helper functions in `src/utils.ts`: `formatDate()` and `formatDateTime()`.
- NEVER use raw, parameterless `new Date().toLocaleDateString()` or `new Date().toLocaleString()`, as Node.js and system locales frequently default to the US format (`m/d/yyyy`).

### Course Header & Cover Images Standard (Must fit completely: `contain`)
All course header photos and cover images across all generated HTML templates (course page hero banner `.hero-image img`, community page hero banner `.hero-image img`, and course card thumbnails `.course-image img`) MUST fit completely and intact in their designated space without being cropped, clipped, or distorted (`object-fit: contain`).
- Always use `object-fit: contain` with proper centering (`display: flex; align-items: center; justify-content: center;`) and a dark/neutral container background (`#020617` or `--panel-2`) so photos of any aspect ratio (e.g., Skool's ~1.94:1 covers or 16:9 portadas) are 100% visible inside their designated area without clipping logos, titles, or artwork boundaries.
- NEVER use `object-fit: cover` on course headers or card thumbnails, as it crops essential text, logos, or artwork edges.


- **ffmpeg Version**: The bundled `ffmpeg-static` is ffmpeg 7.0.2 and crashes on some Loom streams (see **ffmpeg Fallbacks**). A newer bundled build would remove the need for the fallbacks.
- **Rate Limiting & Detection**: Skool may implement rate limiting. The current implementation uses a fixed delay between navigations, but for very large courses, further randomization or human-like interaction patterns should be implemented in `scraper.ts`.
- **Local Chromium**: Playwright currently uses the system cache for browser binaries. For a 100% self-contained folder, configure `PLAYWRIGHT_BROWSERS_PATH=0` in `.env` to force local installation.
- **Internal Link Mapping**: Lesson content often contains links to other lessons or attachments. These are currently absolute URLs. A post-processing step could map these to the local file structure for a fully isolated backup.

## Key Resources
- [yt-dlp Documentation](https://github.com/yt-dlp/yt-dlp): Essential for understanding header requirements and cookie imports.
- [Skool Scraping Insights](https://blog.devinschumacher.com/how-to-download-skoolcom-videos-wget): Background on the `md` parameter and `__NEXT_DATA__` structure.
