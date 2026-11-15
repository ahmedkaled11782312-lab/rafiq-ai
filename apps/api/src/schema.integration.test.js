import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import jwt from 'jsonwebtoken'

const databaseUrl = process.env.DATABASE_URL

test('PostgreSQL schema enforces ownership, course/chapter integrity, value checks and CRUD cascades', {
  skip: !databaseUrl && 'Set DATABASE_URL to a disposable PostgreSQL 16 database to run schema integration tests.',
}, async () => {
  const schema = await readFile(new URL('./db/schema.sql', import.meta.url), 'utf8')
  await (await import('pg')).default.Pool // Ensure the PostgreSQL driver dependency is available.
  const root = await mkdtemp(path.join(os.tmpdir(), 'rafiq-schema-test-'))
  process.env.FILE_STORAGE_DIR = root
  process.env.JWT_SECRET = 'schema-integration-secret-at-least-32-characters'
  const { app, server, pool } = await import('./server.js')
  const ids = { owner: null, other: null, course: null, otherCourse: null, chapter: null, file: null }
  const client = await pool.connect()
  try {
    await client.query(schema)
    const owner = await client.query(
      "INSERT INTO users(email,password_hash,display_name) VALUES($1,'hash','Owner') RETURNING id",
      [`schema-owner-${Date.now()}@example.test`],
    )
    ids.owner = owner.rows[0].id
    const other = await client.query(
      "INSERT INTO users(email,password_hash,display_name) VALUES($1,'hash','Other') RETURNING id",
      [`schema-other-${Date.now()}@example.test`],
    )
    ids.other = other.rows[0].id

    const course = await client.query('INSERT INTO courses(user_id,title,progress,lessons) VALUES($1,$2,100,0) RETURNING id', [ids.owner, 'Schema integration course'])
    ids.course = course.rows[0].id
    const otherCourse = await client.query('INSERT INTO courses(user_id,title) VALUES($1,$2) RETURNING id', [ids.other, 'Other user course'])
    ids.otherCourse = otherCourse.rows[0].id
    const chapter = await client.query('INSERT INTO chapters(course_id,title) VALUES($1,$2) RETURNING id', [ids.course, 'Chapter'])
    ids.chapter = chapter.rows[0].id

    const token = jwt.sign({ sub: ids.owner, role: 'student' }, process.env.JWT_SECRET)
    await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    const coursesResponse = await fetch(`${base}/api/courses`, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(coursesResponse.status, 200)
    assert.deepEqual((await coursesResponse.json()).items.map((item) => item.id), [ids.course])
    const chaptersResponse = await fetch(`${base}/api/courses/${ids.otherCourse}/chapters`, { headers: { Authorization: `Bearer ${token}` } })
    assert.equal(chaptersResponse.status, 404)

    const inserted = await client.query(
      `INSERT INTO files(user_id,course_id,chapter_id,original_name,storage_key,mime_type,size_bytes)
       VALUES($1,$2,$3,'owned.pdf',$4,'application/pdf',0) RETURNING id`,
      [ids.owner, ids.course, ids.chapter, `${ids.owner}/schema-test`],
    )
    ids.file = inserted.rows[0].id
    const ownFileCount = await client.query('SELECT count(*)::int AS count FROM files WHERE user_id=$1', [ids.owner])
    const otherFileCount = await client.query('SELECT count(*)::int AS count FROM files WHERE user_id=$1', [ids.other])
    assert.equal(ownFileCount.rows[0].count, 1)
    assert.equal(otherFileCount.rows[0].count, 0)

    await assert.rejects(
      client.query(`INSERT INTO files(user_id,course_id,original_name,storage_key,mime_type,size_bytes) VALUES($1,$2,'bad-owner.pdf',$3,'application/pdf',0)`, [ids.owner, ids.otherCourse, `${ids.owner}/wrong-course`]),
      (error) => error.code === '23503',
    )
    await assert.rejects(
      client.query(`INSERT INTO files(user_id,course_id,chapter_id,original_name,storage_key,mime_type,size_bytes) VALUES($1,$2,$3,'bad-chapter.pdf',$4,'application/pdf',0)`, [ids.owner, ids.otherCourse, ids.chapter, `${ids.owner}/wrong-chapter`]),
      (error) => error.code === '23503',
    )
    await assert.rejects(client.query('UPDATE courses SET progress=-1 WHERE id=$1', [ids.course]), (error) => error.code === '23514')
    await assert.rejects(client.query('UPDATE courses SET progress=101 WHERE id=$1', [ids.course]), (error) => error.code === '23514')
    await assert.rejects(client.query('UPDATE courses SET lessons=-1 WHERE id=$1', [ids.course]), (error) => error.code === '23514')
    await assert.rejects(
      client.query('INSERT INTO courses(user_id,title,progress) VALUES($1,$2,1.5)', [ids.owner, 'Noninteger progress']),
      (error) => error.code === '22P02' || error.code === '42804',
    )

    await client.query('UPDATE courses SET progress=37, lessons=4 WHERE id=$1', [ids.course])
    const updated = await client.query('SELECT progress,lessons FROM courses WHERE id=$1', [ids.course])
    assert.equal(updated.rows[0].progress, 37)
    assert.equal(updated.rows[0].lessons, 4)
    await client.query('DELETE FROM chapters WHERE id=$1', [ids.chapter])
    const detachedChapter = await client.query('SELECT course_id,chapter_id FROM files WHERE id=$1', [ids.file])
    assert.equal(detachedChapter.rows[0].course_id, ids.course)
    assert.equal(detachedChapter.rows[0].chapter_id, null)
    await client.query('DELETE FROM courses WHERE id=$1', [ids.course])
    const detachedCourse = await client.query('SELECT course_id FROM files WHERE id=$1', [ids.file])
    assert.equal(detachedCourse.rows[0].course_id, null)
    await client.query('DELETE FROM files WHERE id=$1', [ids.file])
    const deletedFile = await client.query('SELECT id FROM files WHERE id=$1', [ids.file])
    assert.equal(deletedFile.rowCount, 0)
  } finally {
    if (ids.owner || ids.other) {
      await client.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [[ids.owner, ids.other].filter(Boolean)]).catch(() => {})
    }
    client.release()
    await pool.end()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
})
