import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import pg from 'pg'

const app = express()
const port = Number(process.env.PORT || 4000)
app.disable('x-powered-by')
app.use(helmet())
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }))
app.use(express.json({ limit: '1mb' }))
const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false } }) : null

app.get('/api/health', async (_req, res) => {
  let database = 'not_configured'
  if (pool) {
    try { await pool.query('SELECT 1'); database = 'connected' }
    catch { database = 'unavailable' }
  }
  res.status(database === 'unavailable' ? 503 : 200).json({ status: database === 'unavailable' ? 'degraded' : 'ok', database, service: 'rafiq-ai-api' })
})
app.get('/api/courses', (_req, res) => res.status(501).json({ error: 'COURSES_NOT_IMPLEMENTED', message: 'خدمة المواد ستُفعّل في المرحلة الثانية.' }))
app.use((err, _req, res, _next) => {
  console.error('Unhandled API error:', err.message)
  res.status(500).json({ error: 'INTERNAL_ERROR', message: 'حدث خطأ غير متوقع.' })
})
app.listen(port, () => console.log(`Rafiq AI API listening on http://localhost:${port}`))
