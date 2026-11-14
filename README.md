# Rafiq AI

Arabic RTL study platform (React/TypeScript + Express + PostgreSQL). This repository provides server-side persistent file storage; user files are not stored in browser LocalStorage.

## Requirements
- Node.js 20+
- PostgreSQL 14+ (database migrations/schema)
- A persistent writable disk volume mounted for `FILE_STORAGE_DIR` in production. Container-local ephemeral disks will lose files when instances are replaced.

## Local setup
1. Copy `.env.example` to `.env`; set a strong random `JWT_SECRET` (32+ chars).
2. Create PostgreSQL database `rafiq_ai` and apply schema: `psql "$DATABASE_URL" -f apps/api/src/db/schema.sql`.
3. Run `npm install` from the repository root.
4. Run `npm run dev`, then open Vite's printed URL. API defaults to port 4000.
5. Set `FILE_STORAGE_DIR` to a backed-up persistent volume path for production. Back up the volume and PostgreSQL together.

## File library API
All file endpoints require a valid Bearer JWT created by database-backed `/api/auth/register` or `/api/auth/login`.
- `GET /api/library/files?q=&courseId=&chapterId=&type=&sort=` — search/filter/sort metadata.
- `POST /api/library/files` — multipart form `file`, optional `courseId`, `chapterId`.
- `GET /api/library/files/:id/content` — authorized inline file bytes; `?download=1` downloads. The browser library uses an authenticated fetch rather than a public URL.
- `PATCH /api/library/files/:id` with `{ "name": "..." }` — rename.
- `DELETE /api/library/files/:id` — delete metadata and stored bytes.
- `GET/POST /api/courses/:courseId/chapters` — list/create chapters.
- `POST /api/library/merge-pdf` with ordered `{ "fileIds": ["uuid", ...], "name": "book.pdf" }` — merges 2–100 PDF files from one course; given array order is preserved and result is stored as a normal library file.

Accepted formats: PDF, DOCX, PPTX, common audio (MP3, WAV, M4A, OGG, WebM), and images (PNG, JPEG, GIF, WebP). Default upload limit is 100 MiB (`MAX_FILE_BYTES`). Office files are downloadable; PDF, image, and audio files have in-app previews supported by the browser.

## Verification
`npm test` runs the API integration suite. It requires a disposable PostgreSQL database, `DATABASE_URL`, and a writable `FILE_STORAGE_DIR`. The test deliberately fails/skips when the required infrastructure is absent; no in-memory fallback is used for file persistence.

## Important deployment note
The disk backend is persistent only if the host mounts persistent storage. For multi-instance deployments, replace the local filesystem adapter with a private S3-compatible object store and keep `storage_key` private. Never expose the upload directory as static/public assets.
