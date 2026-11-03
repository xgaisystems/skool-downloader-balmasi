# 🎓 Skool Downloader

A robust, platform-independent CLI tool to create local, offline backups of your [Skool.com](https://skool.com) courses. 

This tool downloads video content, localizes images, preserves course attachments, and generates a navigable, styled HTML structure that mirrors the online classroom.

## ✨ Features

- **🚀 Smart Binary Management:** Ships the correct `ffmpeg` for your OS (Windows, macOS, Linux) and architecture (Intel, Apple Silicon ARM, Linux ARM) as an install-time dependency, and downloads `yt-dlp` on first run. If the bundled `ffmpeg` cannot be installed, an `ffmpeg` on your `PATH` is used instead.
- **📹 High-Quality Video:** Downloads the highest available quality and applies `+faststart` for instant browser playback.
- **📄 Asset Localization:** Downloads all lesson images locally and rewrites HTML paths for true offline 100% viewing.
- **📎 Resource Preservation:** Automatically fetches course attachments (PDFs, DOCX, etc.) via Skool's API.
- **🎯 Single Lesson Mode:** Download a whole course or just a single lesson using a specific URL.
- **🛠 Interrupted Download Recovery:** Skips already downloaded files and includes a tool to regenerate the index page.
- **♻️ Self-Updating `yt-dlp`:** Checks once a day for a newer `yt-dlp` and installs it before downloading, so video sites that change how they serve media keep working. The previous copy is kept for a one-command rollback.
- **🧯 Video Merge Fallback:** If `ffmpeg` crashes while merging a video's streams, the download is retried with another `ffmpeg` and then with a single-file format that needs no merge.
- **📋 Failure Report:** Lessons and videos that fail are listed at the end of the run and saved to `.download-failures.json` in the course folder. Rerunning the same command retries exactly those.
- **📌 Community Posts:** Posts pinned to a lesson are saved with the lesson, attachments included.
- **✅ Progress Tracking:** Mark lessons as done in the offline pages, with progress per course and per community, synced live across tabs and devices through a small local server (`skool serve`).

## 🛠 Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [npm](https://www.npmjs.com/)

**Note:** No system-wide installation of `yt-dlp` or `ffmpeg` is required. `ffmpeg` arrives with `npm install`, and `yt-dlp` is fetched on first run into a per-user cache folder, so it is downloaded once no matter which directory you run the tool from:

| Platform | Location |
| --- | --- |
| macOS | `~/Library/Caches/skool-downloader/bin` |
| Linux | `~/.cache/skool-downloader/bin` |
| Windows | `%LOCALAPPDATA%\skool-downloader\bin` |

If `XDG_CACHE_HOME` is set, it wins on every platform. Set `SKOOL_DOWNLOADER_CACHE_DIR` to choose the folder yourself; it overrides everything else. Your `downloads/`, `.auth/` and `cookies.txt` stay in the directory you run the tool from.

`ffmpeg` is what merges the separate video and audio streams that most high-quality sources deliver, so it is required for video downloads. It installs automatically through the `ffmpeg-static` package. npm 12 and later only run the install scripts of packages listed under `allowScripts` in `package.json`; `ffmpeg-static` is already listed there, so `npm install` still fetches the binary. If that install is blocked (an offline machine, a restrictive proxy, or an unsupported platform), install `ffmpeg` yourself and the tool will pick it up from your `PATH`.

Installing a system `ffmpeg` is worth it even when the bundled one works. The bundled build (ffmpeg 7.0.2) crashes on some Loom videos, and a system `ffmpeg` is the first thing the tool retries with. To use a specific build, point `SKOOL_FFMPEG_PATH` at it; it is tried before any other.

```bash
# macOS
brew install ffmpeg
# Windows
winget install Gyan.FFmpeg
# Linux
sudo apt install ffmpeg
```

## 🚀 Getting Started

### 1. Installation

```bash
git clone https://github.com/xgaisystems/skool-downloader-balmasi.git
cd skool-downloader-balmasi
npm install
```

### 2. Authentication

Skool uses secure authentication. This tool uses a manual login flow to capture your session safely.

```bash
npm run login
```
*A browser window will open. Log in to your Skool account. Once you see your dashboard, the script will save your session and close the browser.*

### 3. Using NPX

This package is published on npm, so you can run the CLI without installing anything locally:

```bash
npx skool-downloader
```

If you prefer to stay completely local (and allow offline development), run `npm install` once and use `npm run skool` as shown below.

### 4. Downloading a Course

To download an entire classroom:

```bash
npm run skool https://www.skool.com/your-community/classroom/course-id
```

To download **all courses** in a community classroom:

```bash
npm run skool https://www.skool.com/your-community/classroom
```

To download **multiple courses** interactively:

```bash
npm run skool
```
Then choose **Download multiple courses** and select the courses you want. Courses your account cannot open are listed as locked and skipped.

You can also run `npx skool-downloader` to enter the same interactive menu.

To download only a **single lesson**:

```bash
npm run skool "https://www.skool.com/your-community/classroom/course-id?md=lesson-id"
```

## 📁 Output Structure

The tool creates a `downloads/` folder with the following structure:
```text
downloads/
└── Community Name/
    ├── index.html (All downloaded courses of the community)
    └── Course Name/
        ├── index.html (Master navigation page)
        ├── .download-failures.json (Only when something failed)
        └── 1-Module Name/
            ├── 1-Lesson Title/
            │   ├── index.html (The lesson page)
            │   ├── lesson.json (Lesson manifest; records a video error if there was one)
            │   ├── video.mp4
            │   ├── assets/ (Localized images)
            │   ├── resources/ (Attachments)
            │   └── posts/ (Attachments of the community posts pinned to the lesson)
            └── ...
```

`downloads/progress.json` holds the lessons marked as done when you use `skool serve`.

## ⚠️ When Something Fails

At the end of each course the tool lists every lesson or video that failed, with the reason, and writes the same list to `.download-failures.json` in the course folder. Files that were already downloaded are skipped on the next run, so running the same command again retries only what is missing. The file is removed once a run completes without failures.

Go easy on Skool: it detects automated traffic, and an account flagged as a bot can lose access. Prefer a lower lesson concurrency for big communities (`-c 2` or `-c 4`, or *gentle*/*steady* in the interactive menu) and avoid hammering the same course with repeated runs.

## ✅ Progress Tracking and the Local Server

Every lesson page has a tick to mark it as done, and the course and community pages show how many lessons are done. Progress is kept in the browser. To keep it in sync across tabs, browsers and devices, start the local server from the folder that contains `downloads/`:

```bash
npm run serve
# or
skool serve [--port 3100] [--host 127.0.0.1]
```

Then open `http://localhost:3100/`, which lists the downloaded communities. Progress is saved to `downloads/progress.json`.

- The server only accepts connections from your own computer. `--host 0.0.0.0` opens it to your network (to follow a course from a phone, for example); anyone on that network can then see the courses and change the progress.
- Pages opened directly from disk (`file://`) sync with port 3100 only. With another `--port`, open the courses through the server instead.
- Pages downloaded with an older version may point to another port or miss the ticks. `npm run regenerate-index` updates them.

## 🔧 Advanced

### Keeping `yt-dlp` current

`yt-dlp` is only as good as its extractors, and those break whenever a video
site changes how it serves media. An old copy fails with errors such as
`HTTP Error 403: Forbidden` or `Requested format is not available`.

The tool handles this by itself. Before the first lesson of a run it looks at
the installed version, and if that build is more than 30 days old it checks
GitHub for a newer release and installs it. The check runs at most once a day,
and never more than once per run. If GitHub cannot be reached, the run
continues on the copy you already have.

To update by hand:

```bash
npm run skool update
# or, if installed globally
skool update
```

Each update keeps the copy it replaced. If a new `yt-dlp` release behaves worse
than the old one, go back to it:

```bash
skool update --rollback
```

To turn the automatic check off, set `SKOOL_NO_YTDLP_UPDATE=1`. You can still
run `skool update` when you want to.

### Regenerating the Index
If you manually move files or skip lessons, you can regenerate the master `index.html` file based on the current contents of your `downloads/` folder. This also brings lesson pages saved by older versions up to date (progress ticks and the sync script):

```bash
npm run regenerate-index
```

## 🛡 Disclaimer

This tool is for **personal backup and offline viewing purposes only**. Please respect the content creators' terms of service and intellectual property rights. Do not distribute downloaded content without permission.

## 📄 License

This project is licensed under the **Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)** license. See `LICENSE` for the full legal code.
