#!/usr/bin/env node
import fs from 'fs'
import path from 'path'

const SCRAPED = path.resolve('data/courses.json')
const SHEET = path.resolve('data/courses_from_sheet_AI.json')

function readJson(file) {
  if (!fs.existsSync(file)) {
    console.error(`Missing file: ${file}`)
    process.exit(2)
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function normalizeCode(code) {
  if (!code) return ''
  return String(code).trim().toUpperCase()
}

function normalizeCredits(c) {
  if (!c) return ''
  return String(c).trim()
}

function normalizeTitle(t) {
  if (!t) return ''
  return String(t)
    .replace(/\s+/g, ' ')
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .trim()
    .toLowerCase()
}

// extract semester number like 'Semester 1' -> 1
function semesterNumber(name) {
  if (!name) return null
  const m = /semester\s*[-:]?\s*(\d+)/i.exec(name)
  if (m) return Number(m[1])
  const m2 = /semester[- ]?(\d+)/i.exec(name)
  if (m2) return Number(m2[1])
  return null
}

// Build sheet semester map - keep groups separate
function buildSheetSemesterMap(sheet) {
  const map = new Map()
  for (const sem of sheet.semesters || []) {
    const key = sem.name || '(unknown)'
    if (!map.has(key)) map.set(key, { name: key, courses: [] })
    map.get(key).courses.push(...(sem.courses || []))
  }
  return map
}

// Normalize semester/group names for flexible matching
function normalizeSemKey(name) {
  if (!name) return ''
  let s = String(name).toLowerCase()
  s = s.replace(/[-–—]/g, ' ')
  s = s.replace(/[(),.:]/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/\b(?:semester)\s+(i{1,3}|iv|v)\b/gi, (m, r) => 'semester ' + romanToInt(r))
  s = s.replace(/\b(i{1,3}|iv|v)\b/gi, (m, r) => romanToInt(r))
  s = s.replace(/pre\s*-?\s*medical/g, 'pre medical')
  return s
}

function romanToInt(r) {
  if (!r) return r
  const m = r.toUpperCase()
  if (m === 'I') return '1'
  if (m === 'II') return '2'
  if (m === 'III') return '3'
  if (m === 'IV') return '4'
  if (m === 'V') return '5'
  return m
}

function compareSemesters(fetchedSem, validSemMerged) {
  const fetchedCourses = fetchedSem.courses || []
  const validCourses = validSemMerged.courses || []

  const fingerprint = c => `${normalizeCode(c.code)}|${normalizeCredits(c.credits)}`

  function isTotalCourse(c) {
    if (!c) return false
    const code = normalizeCode(c.code)
    const title = String(c.title || '').toLowerCase()
    if (!code && !title) return false
    if (code === 'TOTAL' || code === 'GRAND TOTAL') return true
    if (title.includes('total')) return true
    return false
  }

  const makeCountMap = (arr) => {
    const m = new Map()
    for (const c of arr) {
      if (isTotalCourse(c)) continue
      const key = fingerprint(c)
      const entry = m.get(key) || { count: 0, sample: c }
      entry.count += 1
      m.set(key, entry)
    }
    return m
  }

  const fMap = makeCountMap(fetchedCourses)
  const vMap = makeCountMap(validCourses)
  const diffs = []

  const missingList = []
  const countMismatches = []
  for (const [k, vEntry] of vMap.entries()) {
    const fEntry = fMap.get(k)
    if (!fEntry) {
      missingList.push({ key: k, entry: vEntry })
      continue
    }
    if (fEntry.count !== vEntry.count) {
      countMismatches.push({ course: vEntry.sample, fetchedCount: fEntry.count, validCount: vEntry.count })
    }
  }

  const extraList = []
  for (const [k, fEntry] of fMap.entries()) {
    if (!vMap.has(k)) {
      extraList.push({ key: k, entry: fEntry })
    }
  }

  // Title similarity helpers
  const words = s => String(s || '').toLowerCase().replace(/[\W_]+/g, ' ').split(/\s+/).map(w => w.replace(/s$/,'')) .filter(w => w.length > 2)
  const jaccard = (a, b) => {
    const A = new Set(words(a))
    const B = new Set(words(b))
    if (A.size === 0 || B.size === 0) return 0
    let inter = 0
    for (const x of A) if (B.has(x)) inter++
    const uni = new Set([...A, ...B]).size
    return inter / uni
  }
  const acronym = s => (words(s).map(w => w[0]).join('') || '').toUpperCase()

  // Try to pair missing vs extra as code-mismatch
  const pairedMissing = new Set()
  const pairedExtra = new Set()
  for (let i = 0; i < missingList.length; i++) {
    const m = missingList[i]
    const mCourse = m.entry.sample
    for (let j = 0; j < extraList.length; j++) {
      if (pairedExtra.has(j)) continue
      const e = extraList[j]
      const eCourse = e.entry.sample
      if (normalizeCredits(mCourse.credits) !== normalizeCredits(eCourse.credits)) continue
      const sim = jaccard(mCourse.title, eCourse.title)
      const acrM = acronym(mCourse.title)
      const acrE = acronym(eCourse.title)
      const subs = String(mCourse.title || '').toLowerCase().includes(String(eCourse.title || '').toLowerCase()) || String(eCourse.title || '').toLowerCase().includes(String(mCourse.title || '').toLowerCase())
      const tokenIntersection = words(mCourse.title).some(t => words(eCourse.title).includes(t))
      if (sim >= 0.15 || (acrM && acrE && (acrM.includes(acrE) || acrE.includes(acrM))) || subs || tokenIntersection) {
        diffs.push({ type: 'code-mismatch', fetched: eCourse, valid: mCourse })
        pairedMissing.add(i)
        pairedExtra.add(j)
        break
      }
    }
  }

  // Remaining missing
  for (let i = 0; i < missingList.length; i++) {
    if (pairedMissing.has(i)) continue
    const m = missingList[i]
    diffs.push({ type: 'missing-in-fetched', count: m.entry.count, course: m.entry.sample })
  }

  // Remaining extras
  for (let j = 0; j < extraList.length; j++) {
    if (pairedExtra.has(j)) continue
    const e = extraList[j]
    diffs.push({ type: 'extra-in-fetched', count: e.entry.count, course: e.entry.sample })
  }

  // Append count mismatches
  for (const cm of countMismatches) diffs.push({ type: 'count-mismatch', ...cm })

  return diffs
}

async function sendEmailReport(report) {
  const lines = []
  lines.push(`Comparison report (FETCHED vs VALID) - comparedAt: ${report.comparedAt}`)
  lines.push('')
  for (const sem of report.semesters) {
    lines.push(`${sem.name}: ${sem.diffCount} difference(s)`)
    for (const d of sem.diffs) {
      if (d.type === 'missing-in-fetched') {
        const c = d.course || {}
        lines.push(`MISSING: code='${c.code||''}' title='${c.title||''}' credits='${c.credits||''}' (count=${d.count})`)
        continue
      }
      if (d.type === 'count-mismatch') {
        const c = d.course || {}
        lines.push(`COUNT MISMATCH: code='${c.code||''}' title='${c.title||''}' website=${d.fetchedCount} sheet=${d.validCount}`)
        continue
      }
      if (d.type === 'code-mismatch') {
        const f = d.fetched || {}
        const v = d.valid || {}
        lines.push(`CODE MISMATCH: website='${f.code||''}' vs sheet='${v.code||''}' credits='${normalizeCredits(f.credits)||normalizeCredits(v.credits)}'`) 
        continue
      }
      if (d.type === 'extra-in-fetched') {
        const c = d.course || {}
        lines.push(`EXTRA IN WEBSITE: code='${c.code||''}' title='${c.title||''}' credits='${c.credits||''}' (count=${d.count})`)
        continue
      }
    }
    lines.push('')
  }

  const message = lines.join('\n')

  const payload = {
    access_key: 'f97134f9-0923-4f79-8ebe-7db35d6a2fa9',
    name: 'AI Curriculum Comparer',
    email: 'arqam.waheed.dev@gmail.com',
    to: 'arqam.waheed.dev@gmail.com',
    subject: `AI Curriculum differences report - ${report.comparedAt}`,
    message,
    honeypot: ''
  }

  try {
    const form = new FormData()
    for (const k of Object.keys(payload)) form.append(k, payload[k])

    const res = await fetch('https://api.web3forms.com/submit', {
      method: 'POST',
      body: form
    })
    let data
    try { data = await res.json() } catch (e) { data = { ok: res.ok, status: res.status, statusText: res.statusText } }
    if (res.ok) {
      console.log('Email report sent successfully (web3forms). Response:', data)
      return { ok: true, providerResponse: data }
    } else {
      console.error('Failed to send email report (web3forms). Response:', data)
      const smtpResult = await sendViaSmtpIfConfigured(report)
      return { ok: false, providerResponse: data, smtpFallback: smtpResult }
    }
  } catch (err) {
    console.error('Error sending email report (web3forms):', err && err.message ? err.message : err)
    const smtpResult = await sendViaSmtpIfConfigured(report)
    return { ok: false, error: err, smtpFallback: smtpResult }
  }
}

async function sendViaSmtpIfConfigured(report) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_TO } = process.env
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return { attempted: false, reason: 'SMTP not configured (missing env vars)' }
  }

  try {
    const nodemailer = await import('nodemailer')
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT ? Number(SMTP_PORT) : 587,
      secure: SMTP_PORT === '465',
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    })

    const lines = []
    lines.push(`AI Curriculum Comparison report (FETCHED vs VALID) - comparedAt: ${report.comparedAt}`)
    lines.push('')
    for (const sem of report.semesters) {
      lines.push(`${sem.name}: ${sem.diffCount} difference(s)`)
      for (const d of sem.diffs) {
        if (d.type === 'missing-in-fetched') {
          const c = d.course || {}
          lines.push(`MISSING: code='${c.code||''}' title='${c.title||''}' credits='${c.credits||''}' (count=${d.count})`)
          continue
        }
        if (d.type === 'count-mismatch') {
          const c = d.course || {}
          lines.push(`COUNT MISMATCH: code='${c.code||''}' title='${c.title||''}' website=${d.fetchedCount} sheet=${d.validCount}`)
          continue
        }
        if (d.type === 'code-mismatch') {
          const f = d.fetched || {}
          const v = d.valid || {}
          lines.push(`CODE MISMATCH: website='${f.code||''}' vs sheet='${v.code||''}' credits='${normalizeCredits(f.credits)||normalizeCredits(v.credits)}'`) 
          continue
        }
        if (d.type === 'extra-in-fetched') {
          const c = d.course || {}
          lines.push(`EXTRA IN WEBSITE: code='${c.code||''}' title='${c.title||''}' credits='${c.credits||''}' (count=${d.count})`)
          continue
        }
      }
      lines.push('')
    }

    const message = lines.join('\n')

    const info = await transporter.sendMail({
      from: SMTP_USER,
      to: EMAIL_TO || 'arqam.waheed.dev@gmail.com',
      subject: `AI Curriculum differences report - ${report.comparedAt}`,
      text: message
    })

    console.log('SMTP fallback sent message id:', info && info.messageId)
    return { attempted: true, ok: true, info }
  } catch (err) {
    console.error('SMTP fallback failed:', err && err.message ? err.message : err)
    return { attempted: true, ok: false, error: err }
  }
}

async function main() {
  const scraped = readJson(SCRAPED)
  const sheet = readJson(SHEET)

  const sheetMap = buildSheetSemesterMap(sheet)

  const report = { comparedAt: new Date().toISOString(), semesters: [] }
  let totalDiffs = 0

  const scrapedSems = scraped.semesters || []
  const matchedSheetKeys = new Set()
  for (const scrapedSem of scrapedSems) {
    const num = semesterNumber(scrapedSem.name)
    let matchedKey = null
    if (sheetMap.has(scrapedSem.name)) {
      matchedKey = scrapedSem.name
    } else {
      const norm = normalizeSemKey(scrapedSem.name)
      for (const [k] of sheetMap.entries()) {
        if (normalizeSemKey(k) === norm) {
          matchedKey = k
          break
        }
      }
      if (!matchedKey && num != null) {
        for (const [k] of sheetMap.entries()) {
          if (semesterNumber(k) === num) {
            matchedKey = k
            break
          }
        }
      }
    }

    const validSem = matchedKey ? sheetMap.get(matchedKey) : { name: scrapedSem.name, courses: [] }
    if (matchedKey) matchedSheetKeys.add(matchedKey)

    const diffs = compareSemesters(scrapedSem, validSem)
    report.semesters.push({ name: scrapedSem.name, validKey: validSem.name, diffCount: diffs.length, diffs })
    totalDiffs += diffs.length
  }

  // Check for sheet semesters not matched
  for (const [key, sheetSem] of sheetMap.entries()) {
    if (matchedSheetKeys.has(key)) continue
    const diffs = compareSemesters({ name: key, courses: [] }, sheetSem)
    if (diffs.length > 0) {
      report.semesters.push({ name: `(extra in valid) ${key}`, validKey: key, diffCount: diffs.length, diffs })
      totalDiffs += diffs.length
    }
  }

  // Print human friendly report
  console.log('\n' + '='.repeat(60))
  console.log('AI CURRICULUM COMPARISON REPORT')
  console.log('='.repeat(60))
  console.log(`Compared at: ${report.comparedAt}`)
  console.log(`Website data: ${SCRAPED}`)
  console.log(`Authoritative data: ${SHEET}`)
  console.log('='.repeat(60))
  console.log(`\nTotal semesters compared: ${report.semesters.length}`)
  console.log(`Total differences found: ${totalDiffs}\n`)

  for (const sem of report.semesters) {
    // Clean up semester name for display
    let displayName = sem.name
      .replace(/^Semester-/, 'Semester ')
      .replace(/For Pre-Medical Students Only \(Semester-/i, 'Pre-Medical Students - Semester ')
      .replace(/\)$/, '')
      .replace(/For Pre-medical Students only \(Summer Semester\)/i, 'Pre-Medical Students - Summer')
      .replace(/\(extra in valid\)\s*/i, '')
      .replace(/For Pre- medical Students only \(Summer\)/i, 'Pre-Medical Students - Summer')
    
    // Skip duplicate summer semester entries
    if (displayName.includes('Pre-Medical') && displayName.includes('Summer') && sem.name.includes('extra in valid')) {
      continue
    }
    
    console.log('='.repeat(60))
    console.log(`${displayName}`)
    console.log('='.repeat(60))
    
    if (sem.diffCount === 0) {
      console.log('\nNo differences\n')
      continue
    }
    
    // Group differences by type
    const codeMismatches = []
    const missing = []
    const extra = []
    const countMismatches = []
    
    for (const d of sem.diffs) {
      if (d.type === 'code-mismatch') {
        codeMismatches.push(d)
      } else if (d.type === 'missing-in-fetched') {
        missing.push(d)
      } else if (d.type === 'extra-in-fetched') {
        extra.push(d)
      } else if (d.type === 'count-mismatch') {
        countMismatches.push(d)
      }
    }
    
    // Print code mismatches
    if (codeMismatches.length > 0) {
      console.log('\nCode mismatches:')
      for (const d of codeMismatches) {
        const f = d.fetched || {}
        const v = d.valid || {}
        console.log(`  ${f.code || '(none)'} (website) → should be ${v.code || '(none)'}`)
      }
    }
    
    // Print missing courses
    if (missing.length > 0) {
      console.log('\nMissing from website:')
      for (const d of missing) {
        const c = d.course || {}
        const code = c.code || '(no code)'
        const title = c.title || '(no title)'
        const credits = c.credits ? ` (${c.credits})` : ''
        console.log(`  ${code} – ${title}${credits}`)
      }
    }
    
    // Print extra courses
    if (extra.length > 0) {
      console.log('\nExtra on website:')
      for (const d of extra) {
        const c = d.course || {}
        const code = c.code || '(no code)'
        const title = c.title || '(no title)'
        const credits = c.credits ? ` (${c.credits})` : ''
        console.log(`  ${code} – ${title}${credits}`)
      }
    }
    
    // Print count mismatches
    if (countMismatches.length > 0) {
      console.log('\nCount mismatches:')
      for (const d of countMismatches) {
        const c = d.course || {}
        const code = c.code || '(no code)'
        const title = c.title || '(no title)'
        console.log(`  ${code} – ${title}: website has ${d.fetchedCount}, sheet has ${d.validCount}`)
      }
    }
    
    console.log('')
  }
  
  console.log('='.repeat(60))
  console.log('END OF REPORT')
  console.log('='.repeat(60) + '\n')

  // Persist machine-readable report
  try {
    const outdir = path.resolve('data')
    if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true })
    fs.writeFileSync(path.resolve(outdir, 'compare_report_AI.json'), JSON.stringify(report, null, 2), 'utf8')
    console.log('Wrote machine-readable report to data/compare_report_AI.json')
  } catch (err) {
    console.error('Failed to write data/compare_report_AI.json:', err && err.message ? err.message : err)
  }

  // Attempt to email when differences exist
  if (totalDiffs > 0) {
    try {
      const r = await sendEmailReport(report)
      if (!r.ok) {
        console.error('Sending email failed; see logs above.')
      }
    } catch (err) {
      console.error('Unexpected error while sending email report:', err)
    }
  } else {
    console.log('No differences found; skipping email send.')
  }

  // Exit 0 if no diffs, else exit 1
  process.exit(totalDiffs === 0 ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('compare_courses_AI.js')) {
  main()
}
