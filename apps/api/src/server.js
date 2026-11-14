import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import pg from 'pg'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import multer from 'multer'
import { PDFDocument } from 'pdf-lib'
import { fileTypeFromFile } from 'file-type'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

const app = express()
const port = Number(process.env.PORT || 4000)
const jwtSecret = process.env.JWT_SECRET
const storageRoot = path.resolve(process.env.FILE_STORAGE_DIR || './var/uploads')
const maxFileBytes = Number(process.env.MAX_FILE_BYTES || 104857600)
const allowedExtensions = new Set(['.pdf', '.docx', '.pptx', '.mp3', '.wav', '.m4a', '.ogg', '.webm', '.png', '.jpg', '.jpeg', '.gif', '.webp'])
const allowedMime = new Set([
  'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/ogg', 'audio/webm',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
])

if (process.env.NODE_ENV === 'production' && (!jwtSecret || jwtSecret.length < 32)) {
  throw new Error('JWT_SECRET must be set to a random value of at least 32 characters in production.')
}
if (!jwtSecret) console.warn('Using development-only JWT secret; set JWT_SECRET before deployment.')
const signingSecret = jwtSecret || 'local-development-only-secret-change-before-deploy-32'

app.disable('x-powered-by')
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }))
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }))
app.use(express.json({ limit: '1mb' }))

const pool = process.env.DATABASE_URL ? new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
}) : null

const authRequired = (req, res, next) => {
  const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : ''
  const token = bearer || (req.path.endsWith('/content') ? String(req.query.token || '') : '')
  if (!token) return res.status(401).json({ error: 'UNAUTHORIZED', message: 'يجب تسجيل الدخول أولاً.' })
  try {
    req.user = jwt.verify(token, signingSecret)
    return next()
  } catch {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'رمز الدخول غير صالح.' })
  }
}

const requireDatabase = (_req, res, next) => {
  if (!pool) return res.status(503).json({ error: 'DATABASE_REQUIRED', message: 'تخزين الملفات يتطلب إعداد PostgreSQL عبر DATABASE_URL.' })
  return next()
}
const safeName = (name) => String(name || '').replace(/[\\/\u0000-\u001f]/g, '_').trim().slice(0, 240) || 'file'
const digestFile = (filePath) => new Promise((resolve, reject) => {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  stream.on('error', reject)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.on('end', () => resolve(hash.digest('hex')))
})
const metadata = (row) => ({
  id: row.id,
  name: row.original_name,
  type: row.mime_type,
  size: Number(row.size_bytes),
  uploadedAt: row.created_at,
  courseId: row.course_id,
  course: row.course_title || 'عام',
  chapterId: row.chapter_id,
  chapter: row.chapter_title || '',
  checksum: row.checksum_sha256,
})
const diskPathFor = (storageKey) => {
  const resolved = path.resolve(storageRoot, storageKey)
  if (!resolved.startsWith(`${storageRoot}${path.sep}`)) throw new Error('Invalid storage key')
  return resolved
}

const upload = multer({
  storage: multer.diskStorage({
    destination: async (req, _file, callback) => {
      try {
        const dir = path.join(storageRoot, String(req.user.sub))
        await mkdir(dir, { recursive: true })
        callback(null, dir)
      } catch (error) { callback(error) }
    },
    filename: (_req, _file, callback) => callback(null, randomUUID()),
  }),
  limits: { fileSize: maxFileBytes, files: 1 },
  fileFilter: (_req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (!allowedExtensions.has(ext) || !allowedMime.has(file.mimetype)) {
      return callback(new Error('نوع الملف غير مدعوم. ارفع PDF أو DOCX أو PPTX أو ملف صوت أو صورة مدعومة.'))
    }
    callback(null, true)
  },
})

app.get('/api/health', async (_req, res) => {
  let database = 'not_configured'
  if (pool) {
    try { await pool.query('SELECT 1'); database = 'connected' }
    catch { database = 'unavailable' }
  }
  res.status(database === 'unavailable' ? 503 : 200).json({ status: database === 'unavailable' ? 'degraded' : 'ok', database, storage: storageRoot })
})

app.post('/api/auth/register', async (req, res) => {
  const name = String(req.body?.name || '').trim()
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  if (name.length < 2 || name.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8) {
    return res.status(400).json({ error: 'INVALID_INPUT', message: 'أدخل اسماً وبريداً صحيحاً وكلمة مرور من 8 أحرف على الأقل.' })
  }
  if (!pool) return res.status(503).json({ error: 'DATABASE_REQUIRED', message: 'التسجيل يحتاج إلى إعداد PostgreSQL؛ لم يتم إنشاء حساب تجريبي.' })
  try {
    const hash = await bcrypt.hash(password, 12)
    const result = await pool.query('INSERT INTO users (email, password_hash, display_name) VALUES ($1,$2,$3) RETURNING id,email,display_name,role', [email, hash, name])
    const user = result.rows[0]
    return res.status(201).json({ token: jwt.sign({ sub: user.id, email: user.email, role: user.role }, signingSecret, { expiresIn: '7d' }), user: { id: user.id, email: user.email, name: user.display_name, role: user.role } })
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'EMAIL_EXISTS', message: 'هذا البريد مسجل بالفعل.' })
    console.error('Register failed:', error)
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'تعذر إنشاء الحساب.' })
  }
})

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  if (!email || !password) return res.status(400).json({ error: 'INVALID_INPUT', message: 'البريد وكلمة المرور مطلوبان.' })
  if (!pool) return res.status(503).json({ error: 'DATABASE_REQUIRED', message: 'تسجيل الدخول يحتاج إلى إعداد PostgreSQL.' })
  try {
    const result = await pool.query('SELECT id,email,display_name,role,password_hash FROM users WHERE email=$1', [email])
    const user = result.rows[0]
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: 'بيانات الدخول غير صحيحة.' })
    return res.json({ token: jwt.sign({ sub: user.id, email: user.email, role: user.role }, signingSecret, { expiresIn: '7d' }), user: { id: user.id, email: user.email, name: user.display_name, role: user.role } })
  } catch (error) {
    console.error('Login failed:', error)
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'تعذر تسجيل الدخول.' })
  }
})

app.get('/api/courses', authRequired, requireDatabase, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id,title,color FROM courses WHERE user_id=$1 ORDER BY created_at DESC', [req.user.sub])
    return res.json({ items: rows.map((row) => ({ ...row, teacher: 'المعلم', level: 'الثانوية', progress: 0, lessons: 0 })) })
  } catch (error) { console.error(error); return res.status(500).json({ error: 'SERVER_ERROR', message: 'تعذر جلب المواد.' }) }
})

app.get('/api/courses/:courseId/chapters', authRequired, requireDatabase, async (req, res) => {
  try {
    const owned = await pool.query('SELECT id FROM courses WHERE id=$1 AND user_id=$2', [req.params.courseId, req.user.sub])
    if (!owned.rowCount) return res.status(404).json({ error: 'NOT_FOUND', message: 'المادة غير موجودة.' })
    const { rows } = await pool.query('SELECT id,title,position FROM chapters WHERE course_id=$1 ORDER BY position ASC', [req.params.courseId])
    return res.json({ items: rows })
  } catch (error) { console.error(error); return res.status(500).json({ error: 'SERVER_ERROR', message: 'تعذر جلب الفصول.' }) }
})

app.post('/api/courses/:courseId/chapters', authRequired, requireDatabase, async (req, res) => {
  const title = String(req.body?.title || '').trim()
  if (!title || title.length > 180) return res.status(400).json({ error: 'INVALID_INPUT', message: 'عنوان الفصل مطلوب (حتى 180 حرفاً).' })
  try {
    const owned = await pool.query('SELECT id FROM courses WHERE id=$1 AND user_id=$2', [req.params.courseId, req.user.sub])
    if (!owned.rowCount) return res.status(404).json({ error: 'NOT_FOUND', message: 'المادة غير موجودة.' })
    const position = Number.isInteger(req.body?.position) && req.body.position >= 0 ? req.body.position : (await pool.query('SELECT COALESCE(MAX(position),-1)+1 AS position FROM chapters WHERE course_id=$1', [req.params.courseId])).rows[0].position
    const result = await pool.query('INSERT INTO chapters(course_id,title,position) VALUES($1,$2,$3) RETURNING id,title,position', [req.params.courseId,title,position])
    return res.status(201).json({ item: result.rows[0] })
  } catch (error) { console.error(error); return res.status(500).json({ error: 'SERVER_ERROR', message: 'تعذر إنشاء الفصل.' }) }
})

app.get('/api/library/files', authRequired, requireDatabase, async (req, res) => {
  const { q = '', courseId = '', chapterId = '', type = '', sort = 'newest' } = req.query
  const ordering = sort === 'name' ? 'f.original_name ASC' : sort === 'oldest' ? 'f.created_at ASC' : 'f.created_at DESC'
  try {
    const { rows } = await pool.query(
      `SELECT f.id,f.original_name,f.mime_type,f.size_bytes,f.course_id,f.chapter_id,f.checksum_sha256,f.created_at,c.title AS course_title,ch.title AS chapter_title
       FROM files f LEFT JOIN courses c ON c.id=f.course_id LEFT JOIN chapters ch ON ch.id=f.chapter_id
       WHERE f.user_id=$1 AND ($2='' OR f.original_name ILIKE '%'||$2||'%')
         AND ($3='' OR f.course_id::text=$3) AND ($4='' OR f.chapter_id::text=$4)
         AND ($5='' OR f.mime_type LIKE $5||'/%' OR lower(f.original_name) LIKE '%.'||$5)
       ORDER BY ${ordering} LIMIT 200`,
      [req.user.sub, String(q), String(courseId), String(chapterId), String(type)],
    )
    return res.json({ items: rows.map(metadata) })
  } catch (error) { console.error('Library list failed:', error); return res.status(500).json({ error: 'SERVER_ERROR', message: 'تعذر تحميل المكتبة.' }) }
})

app.post('/api/library/files', authRequired, requireDatabase, (req, res, next) => upload.single('file')(req, res, (error) => {
  if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'UPLOAD_FAILED', message: error.code === 'LIMIT_FILE_SIZE' ? 'حجم الملف يتجاوز الحد المسموح.' : error.message })
  next()
}), async (req, res) => {
  const uploaded = req.file
  if (!uploaded) return res.status(400).json({ error: 'FILE_REQUIRED', message: 'اختر ملفاً للرفع.' })
  const cleanup = async () => { try { await unlink(uploaded.path) } catch {} }
  try {
    const ext = path.extname(uploaded.originalname).toLowerCase()
    const detected = await fileTypeFromFile(uploaded.path)
    const expected = ext === '.pdf' ? 'application/pdf' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : null
    if (expected && detected?.mime !== expected) {
      await cleanup()
      return res.status(415).json({ error: 'INVALID_FILE_CONTENT', message: 'محتوى الملف لا يطابق امتداده.' })
    }
    if (['.docx','.pptx'].includes(ext) && detected?.mime !== 'application/zip') {
      await cleanup()
      return res.status(415).json({ error: 'INVALID_FILE_CONTENT', message: 'ملف Office غير صالح أو لا يطابق امتداده.' })
    }
    if (ext === '.pdf' && !detected) {
      await cleanup()
      return res.status(415).json({ error: 'INVALID_FILE_CONTENT', message: 'تعذر التحقق من ملف PDF.' })
    }
    const checksum = await digestFile(uploaded.path)
    const courseId = req.body.courseId || null
    const chapterId = req.body.chapterId || null
    if (courseId) {
      const course = await pool.query('SELECT id FROM courses WHERE id=$1 AND user_id=$2', [courseId, req.user.sub])
      if (!course.rowCount) { await cleanup(); return res.status(404).json({ error: 'COURSE_NOT_FOUND', message: 'المادة غير موجودة.' }) }
    }
    if (chapterId) {
      const chapter = await pool.query('SELECT ch.id FROM chapters ch JOIN courses c ON c.id=ch.course_id WHERE ch.id=$1 AND c.user_id=$2 AND ($3::uuid IS NULL OR c.id=$3)', [chapterId, req.user.sub, courseId])
      if (!chapter.rowCount) { await cleanup(); return res.status(400).json({ error: 'CHAPTER_NOT_FOUND', message: 'الفصل غير موجود أو لا يتبع المادة المختارة.' }) }
    }
    const storageKey = `${req.user.sub}/${uploaded.filename}`
    const result = await pool.query(
      `INSERT INTO files(user_id,course_id,chapter_id,original_name,storage_key,mime_type,size_bytes,checksum_sha256)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id,original_name,mime_type,size_bytes,course_id,chapter_id,checksum_sha256,created_at`,
      [req.user.sub,courseId,chapterId,safeName(uploaded.originalname),storageKey,uploaded.mimetype,uploaded.size,checksum],
    )
    return res.status(201).json({ item: metadata(result.rows[0]) })
  } catch (error) {
    await cleanup()
    if (error.code === '23505') return res.status(409).json({ error: 'DUPLICATE_FILE', message: 'هذا الملف موجود بالفعل في مكتبتك.' })
    console.error('Upload failed:', error)
    return res.status(500).json({ error: 'UPLOAD_FAILED', message: 'فشل حفظ الملف؛ يمكنك إعادة المحاولة.' })
  }
})

const getOwnedFile = (id, userId) => pool.query(
  `SELECT f.*,c.title AS course_title,ch.title AS chapter_title FROM files f
   LEFT JOIN courses c ON c.id=f.course_id LEFT JOIN chapters ch ON ch.id=f.chapter_id
   WHERE f.id=$1 AND f.user_id=$2`, [id,userId],
)

app.get('/api/library/files/:id/content', authRequired, requireDatabase, async (req, res) => {
  try {
    const result = await getOwnedFile(req.params.id, req.user.sub)
    if (!result.rowCount) return res.status(404).json({ error: 'NOT_FOUND', message: 'الملف غير موجود.' })
    const file = result.rows[0]
    const absolute = diskPathFor(file.storage_key)
    res.setHeader('Content-Type', file.mime_type)
    res.setHeader('Content-Length', file.size_bytes)
    res.setHeader('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`)
    return pipeline(createReadStream(absolute), res).catch((error) => { if (!res.headersSent) res.status(404).json({ error: 'FILE_MISSING', message: 'الملف غير موجود في مساحة التخزين.' }); else res.destroy(error) })
  } catch (error) { console.error(error); return res.status(500).json({ error: 'SERVER_ERROR', message: 'تعذر فتح الملف.' }) }
})

app.patch('/api/library/files/:id', authRequired, requireDatabase, async (req, res) => {
  const name = safeName(req.body?.name)
  if (!name || name === 'file') return res.status(400).json({ error: 'INVALID_INPUT', message: 'اسم الملف مطلوب.' })
  try {
    const result = await pool.query(`UPDATE files SET original_name=$1 WHERE id=$2 AND user_id=$3 RETURNING id,original_name,mime_type,size_bytes,course_id,chapter_id,checksum_sha256,created_at`, [name,req.params.id,req.user.sub])
    if (!result.rowCount) return res.status(404).json({ error: 'NOT_FOUND', message: 'الملف غير موجود.' })
    return res.json({ item: metadata(result.rows[0]) })
  } catch (error) { console.error(error); return res.status(500).json({ error: 'SERVER_ERROR', message: 'تعذرت إعادة تسمية الملف.' }) }
})

app.delete('/api/library/files/:id', authRequired, requireDatabase, async (req, res) => {
  const client = await pool.connect()
  let file
  try {
    await client.query('BEGIN')
    const found = await client.query('SELECT id,storage_key FROM files WHERE id=$1 AND user_id=$2 FOR UPDATE', [req.params.id,req.user.sub])
    if (!found.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'NOT_FOUND', message: 'الملف غير موجود.' }) }
    file = found.rows[0]
    await client.query('DELETE FROM files WHERE id=$1 AND user_id=$2', [file.id,req.user.sub])
    await client.query('COMMIT')
    try { await unlink(diskPathFor(file.storage_key)) } catch (error) { if (error.code !== 'ENOENT') console.error('File cleanup needed:', error) }
    return res.json({ success: true })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    console.error(error)
    return res.status(500).json({ error: 'SERVER_ERROR', message: 'تعذر حذف الملف.' })
  } finally { client.release() }
})

app.post('/api/library/merge-pdf', authRequired, requireDatabase, async (req, res) => {
  const fileIds = req.body?.fileIds
  const requestedName = safeName(req.body?.name || 'الكتاب المدمج.pdf')
  if (!Array.isArray(fileIds) || fileIds.length < 2 || fileIds.length > 100 || fileIds.some((id) => typeof id !== 'string')) {
    return res.status(400).json({ error: 'INVALID_INPUT', message: 'حدد فصلين PDF على الأقل وبحد أقصى 100 فصل.' })
  }
  const client = await pool.connect()
  let savedPath
  try {
    const { rows } = await client.query(
      `SELECT f.* FROM files f WHERE f.user_id=$1 AND f.id=ANY($2::uuid[])`, [req.user.sub,fileIds],
    )
    if (rows.length !== fileIds.length) return res.status(404).json({ error: 'FILE_NOT_FOUND', message: 'بعض ملفات الفصول غير موجودة في حسابك.' })
    const byId = new Map(rows.map((row) => [row.id,row]))
    const ordered = fileIds.map((id) => byId.get(id))
    if (ordered.some((file) => file.mime_type !== 'application/pdf')) return res.status(415).json({ error: 'PDF_ONLY', message: 'دمج الكتب متاح لملفات PDF فقط.' })
    const courseIds = new Set(ordered.map((file) => file.course_id).filter(Boolean))
    if (courseIds.size !== 1) return res.status(400).json({ error: 'COURSE_MISMATCH', message: 'اختر فصولاً من مادة واحدة.' })
    const merged = await PDFDocument.create()
    for (const file of ordered) {
      const source = await PDFDocument.load(await (await import('node:fs/promises')).readFile(diskPathFor(file.storage_key)))
      const pages = await merged.copyPages(source, source.getPageIndices())
      pages.forEach((page) => merged.addPage(page))
    }
    const bytes = await merged.save()
    const id = randomUUID()
    const directory = path.join(storageRoot,String(req.user.sub))
    await mkdir(directory,{recursive:true})
    savedPath = path.join(directory,id)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(savedPath,bytes,{flag:'wx'})
    const name = requestedName.toLowerCase().endsWith('.pdf') ? requestedName : `${requestedName}.pdf`
    const storageKey = `${req.user.sub}/${id}`
    const insert = await client.query(
      `INSERT INTO files(user_id,course_id,original_name,storage_key,mime_type,size_bytes,checksum_sha256)
       VALUES($1,$2,$3,$4,'application/pdf',$5,$6)
       RETURNING id,original_name,mime_type,size_bytes,course_id,chapter_id,checksum_sha256,created_at`,
      [req.user.sub,[...courseIds][0],name,storageKey,bytes.length,createHash('sha256').update(bytes).digest('hex')],
    )
    return res.status(201).json({ item: metadata(insert.rows[0]) })
  } catch (error) {
    if (savedPath) await unlink(savedPath).catch(() => {})
    console.error('PDF merge failed:',error)
    return res.status(422).json({ error: 'MERGE_FAILED', message: 'تعذر دمج الملفات؛ تحقق من سلامة ملفات PDF وترتيبها.' })
  } finally { client.release() }
})

app.use((error, _req, res, _next) => {
  console.error('Unhandled API error:', error)
  if (res.headersSent) return res.end()
  return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'حدث خطأ غير متوقع.' })
})

await mkdir(storageRoot,{recursive:true})
const server = app.listen(port, () => console.log(`Rafiq AI API listening on http://localhost:${port}`))
export { app, server, pool }
