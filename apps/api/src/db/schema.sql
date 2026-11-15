CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'teacher', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description TEXT NOT NULL DEFAULT '',
  teacher TEXT NOT NULL DEFAULT 'المعلم',
  level TEXT NOT NULL DEFAULT 'الثانوية',
  color TEXT NOT NULL DEFAULT 'violet',
  progress INTEGER NOT NULL DEFAULT 0,
  lessons INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT courses_progress_range_check CHECK (progress BETWEEN 0 AND 100),
  CONSTRAINT courses_lessons_nonnegative_check CHECK (lessons >= 0)
);

-- Keep existing installations in sync without recreating tables or discarding rows.
ALTER TABLE courses ADD COLUMN IF NOT EXISTS teacher TEXT NOT NULL DEFAULT 'المعلم';
ALTER TABLE courses ADD COLUMN IF NOT EXISTS level TEXT NOT NULL DEFAULT 'الثانوية';
ALTER TABLE courses ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT 'violet';
ALTER TABLE courses ADD COLUMN IF NOT EXISTS progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE courses ADD COLUMN IF NOT EXISTS lessons INTEGER NOT NULL DEFAULT 0;

-- Normalize legacy invalid values before validating the constraints below.
UPDATE courses
SET progress = LEAST(GREATEST(COALESCE(progress, 0), 0), 100),
    lessons = GREATEST(COALESCE(lessons, 0), 0)
WHERE progress IS NULL OR progress < 0 OR progress > 100
   OR lessons IS NULL OR lessons < 0;
ALTER TABLE courses ALTER COLUMN progress SET DEFAULT 0;
ALTER TABLE courses ALTER COLUMN progress SET NOT NULL;
ALTER TABLE courses ALTER COLUMN lessons SET DEFAULT 0;
ALTER TABLE courses ALTER COLUMN lessons SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'courses'::regclass AND conname = 'courses_progress_range_check') THEN
    ALTER TABLE courses ADD CONSTRAINT courses_progress_range_check CHECK (progress BETWEEN 0 AND 100) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'courses'::regclass AND conname = 'courses_lessons_nonnegative_check') THEN
    ALTER TABLE courses ADD CONSTRAINT courses_lessons_nonnegative_check CHECK (lessons >= 0) NOT VALID;
  END IF;
END $$;
ALTER TABLE courses VALIDATE CONSTRAINT courses_progress_range_check;
ALTER TABLE courses VALIDATE CONSTRAINT courses_lessons_nonnegative_check;

CREATE INDEX IF NOT EXISTS courses_user_created_idx ON courses(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS courses_user_id_id_uidx ON courses(user_id, id);

CREATE TABLE IF NOT EXISTS chapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 180),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(course_id, position)
);
CREATE UNIQUE INDEX IF NOT EXISTS chapters_id_course_id_uidx ON chapters(id, course_id);

CREATE TABLE IF NOT EXISTS files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id UUID,
  chapter_id UUID,
  original_name TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
  checksum_sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE files ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS chapter_id UUID;

-- Preserve files while repairing legacy cross-owner or inconsistent references.
-- Detaching bad associations is safer than deleting user content.
UPDATE files f
SET course_id = NULL, chapter_id = NULL
WHERE f.course_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM courses c WHERE c.id = f.course_id AND c.user_id = f.user_id
  );

UPDATE files f
SET course_id = ch.course_id
FROM chapters ch
JOIN courses c ON c.id = ch.course_id
WHERE f.chapter_id = ch.id
  AND f.course_id IS NULL
  AND c.user_id = f.user_id;

UPDATE files f
SET chapter_id = NULL
WHERE f.chapter_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM chapters ch
    JOIN courses c ON c.id = ch.course_id
    WHERE ch.id = f.chapter_id
      AND ch.course_id = f.course_id
      AND c.user_id = f.user_id
  );

-- Replace single-column associations with ownership-aware composite foreign keys.
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_course_id_fkey;
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_chapter_id_fkey;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'files'::regclass AND conname = 'files_user_course_owner_fkey') THEN
    ALTER TABLE files ADD CONSTRAINT files_user_course_owner_fkey
      FOREIGN KEY (user_id, course_id) REFERENCES courses(user_id, id)
      ON DELETE SET NULL (course_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'files'::regclass AND conname = 'files_chapter_course_match_fkey') THEN
    ALTER TABLE files ADD CONSTRAINT files_chapter_course_match_fkey
      FOREIGN KEY (chapter_id, course_id) REFERENCES chapters(id, course_id)
      ON DELETE SET NULL (chapter_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'files'::regclass AND conname = 'files_chapter_requires_course_check') THEN
    ALTER TABLE files ADD CONSTRAINT files_chapter_requires_course_check
      CHECK (chapter_id IS NULL OR course_id IS NOT NULL) NOT VALID;
  END IF;
END $$;
ALTER TABLE files VALIDATE CONSTRAINT files_user_course_owner_fkey;
ALTER TABLE files VALIDATE CONSTRAINT files_chapter_course_match_fkey;
ALTER TABLE files VALIDATE CONSTRAINT files_chapter_requires_course_check;

CREATE INDEX IF NOT EXISTS files_user_course_idx ON files(user_id, course_id);
CREATE INDEX IF NOT EXISTS files_user_chapter_idx ON files(user_id, chapter_id);
CREATE UNIQUE INDEX IF NOT EXISTS files_user_checksum_idx ON files(user_id, checksum_sha256) WHERE checksum_sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_user_due_idx ON tasks(user_id, due_at);

CREATE TABLE IF NOT EXISTS activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id UUID REFERENCES courses(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activities_user_created_idx ON activities(user_id, created_at DESC);
