import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { PDFDocument } from 'pdf-lib'

const databaseUrl = process.env.DATABASE_URL

test('persistent authenticated library upload, preview/download, filters, rename, merge and delete', { skip: !databaseUrl && 'Set DATABASE_URL to a disposable PostgreSQL database to run integration tests.' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rafiq-library-test-'))
  process.env.FILE_STORAGE_DIR = root
  process.env.JWT_SECRET = 'integration-test-secret-at-least-32-characters'
  const { app, server, pool } = await import('./server.js')
  const client = await pool.connect()
  const ids = { user: null, course: null }
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  let auth
  try {
    await client.query('BEGIN')
    const email = `library-test-${Date.now()}@example.test`
    const inserted = await client.query('INSERT INTO users(email,password_hash,display_name) VALUES($1,$2,$3) RETURNING id', [email, await bcrypt.hash('test-password-123', 4), 'Integration test'])
    ids.user = inserted.rows[0].id
    const course = await client.query('INSERT INTO courses(user_id,title) VALUES($1,$2) RETURNING id', [ids.user, 'اختبار المكتبة'])
    ids.course = course.rows[0].id
    await client.query('COMMIT')
    auth = `Bearer ${jwt.sign({ sub: ids.user, email, role: 'student' }, process.env.JWT_SECRET)}`

    const pdf = await PDFDocument.create()
    const page = pdf.addPage([200, 200])
    page.drawText('Persistent Rafiq test')
    const firstPdf = Buffer.from(await pdf.save())
    const second = await PDFDocument.create()
    second.addPage([200, 200]).drawText('Second chapter')
    const secondPdf = Buffer.from(await second.save())

    const uploadPdf = async (buffer, filename) => {
      const form = new FormData()
      form.set('file', new Blob([buffer], { type: 'application/pdf' }), filename)
      form.set('courseId', ids.course)
      const response = await fetch(`${base}/api/library/files`, { method: 'POST', headers: { Authorization: auth }, body: form })
      return { response, body: await response.json() }
    }
    const one = await uploadPdf(firstPdf, 'chapter-1.pdf')
    assert.equal(one.response.status, 201)
    const two = await uploadPdf(secondPdf, 'chapter-2.pdf')
    assert.equal(two.response.status, 201)

    const list = await fetch(`${base}/api/library/files?courseId=${ids.course}&type=pdf&sort=name`, { headers: { Authorization: auth } })
    const listData = await list.json()
    assert.equal(list.status, 200)
    assert.equal(listData.items.length, 2)
    assert.equal(listData.items[0].name, 'chapter-1.pdf')

    const preview = await fetch(`${base}/api/library/files/${one.body.item.id}/content`, { headers: { Authorization: auth } })
    assert.equal(preview.status, 200)
    assert.match(preview.headers.get('content-type'), /application\/pdf/)
    assert.deepEqual(Buffer.from(await preview.arrayBuffer()), firstPdf)

    const download = await fetch(`${base}/api/library/files/${one.body.item.id}/content?download=1`, { headers: { Authorization: auth } })
    assert.match(download.headers.get('content-disposition'), /attachment/)
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), firstPdf)

    const rename = await fetch(`${base}/api/library/files/${one.body.item.id}`, { method: 'PATCH', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'renamed.pdf' }) })
    assert.equal((await rename.json()).item.name, 'renamed.pdf')

    const merged = await fetch(`${base}/api/library/merge-pdf`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ fileIds: [one.body.item.id, two.body.item.id], name: 'final-book.pdf' }) })
    const mergedData = await merged.json()
    assert.equal(merged.status, 201)
    const mergedBytes = await (await fetch(`${base}/api/library/files/${mergedData.item.id}/content`, { headers: { Authorization: auth } })).arrayBuffer()
    assert.equal((await PDFDocument.load(mergedBytes)).getPageCount(), 2)

    server.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const fileAfterRestart = await fetch(`${base}/api/library/files/${one.body.item.id}/content`, { headers: { Authorization: auth } })
    assert.equal(fileAfterRestart.status, 200)
    assert.deepEqual(Buffer.from(await fileAfterRestart.arrayBuffer()), firstPdf)

    const deleted = await fetch(`${base}/api/library/files/${one.body.item.id}`, { method: 'DELETE', headers: { Authorization: auth } })
    assert.equal(deleted.status, 200)
    const afterDelete = await fetch(`${base}/api/library/files/${one.body.item.id}/content`, { headers: { Authorization: auth } })
    assert.equal(afterDelete.status, 404)
  } finally {
    await client.query('DELETE FROM users WHERE id=$1', [ids.user]).catch(() => {})
    client.release()
    await pool.end()
    if (server.listening) await new Promise((resolve) => server.close(resolve))
    await rm(root,{recursive:true,force:true})
  }
})
