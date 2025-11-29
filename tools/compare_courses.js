#!/usr/bin/env node
import fs from 'fs'
import path from 'path'

const SCRAPED = path.resolve('data/courses.json')
const SHEET = path.resolve('data/courses_from_sheet.json')

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

// Merge sheet's pre-med groups into the base semester groups.
// We return an object mapping canonical semester names (e.g. 'Semester 1') -> { name, courses: [...] }
function buildSheetSemesterMap(sheet) {
  // Keep sheet semester groups separate (don't merge pre-med into main semesters).
  // Key by the original semester name so special groups remain distinct.
  const map = new Map()
  for (const sem of sheet.semesters || []) {
    const key = sem.name || '(unknown)'
    if (!map.has(key)) map.set(key, { name: key, courses: [] })
    map.get(key).courses.push(...(sem.courses || []))
  }
  return map
}

// Normalize semester/group names for more flexible matching (case, punctuation, roman/arabic numerals)
function normalizeSemKey(name) {
  if (!name) return ''
  let s = String(name).toLowerCase()
  // replace common punctuation and multiple spaces
  s = s.replace(/[-–—]/g, ' ')
  s = s.replace(/[(),.:]/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  // normalize roman numerals I, II, III, IV, V inside words to digits when present
  s = s.replace(/\b(?:semester)\s+(i{1,3}|iv|v)\b/gi, (m, r) => 'semester ' + romanToInt(r))
  // normalize standalone roman numerals in parentheses or trailing
  s = s.replace(/\b(i{1,3}|iv|v)\b/gi, (m, r) => romanToInt(r))
  // unify 'pre medical' variants
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

function buildSerialMap(courses) {
  const m = new Map()
  for (const c of courses) {
    const serial = c.serial != null ? String(c.serial).trim() : ''
    m.set(serial, c)
  }
  return m
}

function compareSemesters(fetchedSem, validSemMerged) {
  // Compare course sets ignoring order. Courses are considered equivalent when
  // code, credits, and prerequisite (normalized) all match. We allow the same courses in any order
  // and compare counts (multisets).
  const fetchedCourses = fetchedSem.courses || []
  const validCourses = validSemMerged.courses || []

  // Compare by course code, credit hours, and prerequisite
  const fingerprint = c => `${normalizeCode(c.code)}|${normalizeCredits(c.credits)}|${normalizePrereq(c.prerequisite)}`

  function normalizePrereq(p) {
    if (!p) return ''
    const s = String(p).trim().toUpperCase()
    const codePattern = /[A-Z]{2,}[-\s]?\d{2,4}/g
    const codes = s.match(codePattern) || []
    return codes.map(c => c.replace(/\s+/g, '-')).sort().join('|')
  }

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
      if (isTotalCourse(c)) continue // skip totals
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

  // helper: title similarity (Jaccard on words)
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

  // Try to pair missing vs extra as code-mismatch or prerequisite-mismatch when credits match and titles are similar
  const pairedMissing = new Set()
  const pairedExtra = new Set()
  for (let i = 0; i < missingList.length; i++) {
    const m = missingList[i]
    const mCourse = m.entry.sample
    for (let j = 0; j < extraList.length; j++) {
      if (pairedExtra.has(j)) continue
      const e = extraList[j]
      const eCourse = e.entry.sample
      // credits must match
      if (normalizeCredits(mCourse.credits) !== normalizeCredits(eCourse.credits)) continue
      
      // Check if codes match but prerequisites differ
      if (normalizeCode(mCourse.code) === normalizeCode(eCourse.code)) {
        if (normalizePrereq(mCourse.prerequisite) !== normalizePrereq(eCourse.prerequisite)) {
          diffs.push({ type: 'prerequisite-mismatch', fetched: eCourse, valid: mCourse })
          pairedMissing.add(i)
          pairedExtra.add(j)
          break
        }
      }
      
      // titles similar by Jaccard or acronym match or substring
      const sim = jaccard(mCourse.title, eCourse.title)
      const acrM = acronym(mCourse.title)
      const acrE = acronym(eCourse.title)
      const subs = String(mCourse.title || '').toLowerCase().includes(String(eCourse.title || '').toLowerCase()) || String(eCourse.title || '').toLowerCase().includes(String(mCourse.title || '').toLowerCase())
  // loosen matching: accept lower jaccard, acronym inclusion, substring, or at least one common token
  const tokenIntersection = words(mCourse.title).some(t => words(eCourse.title).includes(t))
  if (sim >= 0.15 || (acrM && acrE && (acrM.includes(acrE) || acrE.includes(acrM))) || subs || tokenIntersection) {
        // treat as code mismatch
        diffs.push({ type: 'code-mismatch', fetched: eCourse, valid: mCourse })
        pairedMissing.add(i)
        pairedExtra.add(j)
        break
      }
    }
  }

  // remaining missing
  for (let i = 0; i < missingList.length; i++) {
    if (pairedMissing.has(i)) continue
    const m = missingList[i]
    diffs.push({ type: 'missing-in-fetched', count: m.entry.count, course: m.entry.sample })
  }

  // remaining extras
  for (let j = 0; j < extraList.length; j++) {
    if (pairedExtra.has(j)) continue
    const e = extraList[j]
    diffs.push({ type: 'extra-in-fetched', count: e.entry.count, course: e.entry.sample })
  }

  // append count mismatches
  for (const cm of countMismatches) diffs.push({ type: 'count-mismatch', ...cm })

  return diffs
}

async function sendEmailReport(report) {
  // Build a human readable message from the report object
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
      if (d.type === 'prerequisite-mismatch') {
        const f = d.fetched || {}
        const v = d.valid || {}
        const code = f.code || v.code || '(no code)'
        lines.push(`PREREQUISITE MISMATCH: ${code} - website='${f.prerequisite||'(none)'}' vs sheet='${v.prerequisite||'(none)'}'`)
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

  // Prepare payload for web3forms
  const payload = {
    access_key: 'f97134f9-0923-4f79-8ebe-7db35d6a2fa9',
    name: 'Curriculum Comparer',
    // use your email as the sender so web3forms accepts it as a valid recipient/sender
    email: 'arqam.waheed.dev@gmail.com',
    to: 'arqam.waheed.dev@gmail.com',
    subject: `Curriculum differences report - ${report.comparedAt}`,
    message,
    // common honeypot field expected by some providers
    honeypot: ''
  }

  try {
    // Use multipart/form-data like the original web3forms sample
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
      // attempt SMTP fallback if configured
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
  // requires env vars: SMTP_HOST, SMTP_PORT (optional), SMTP_USER, SMTP_PASS
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
        if (d.type === 'prerequisite-mismatch') {
          const f = d.fetched || {}
          const v = d.valid || {}
          const code = f.code || v.code || '(no code)'
          lines.push(`PREREQUISITE MISMATCH: ${code} - website='${f.prerequisite||'(none)'}' vs sheet='${v.prerequisite||'(none)'}'`)
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
      subject: `Curriculum differences report - ${report.comparedAt}`,
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

  // iterate scraped semesters and compare against merged sheet semesters
  const report = { comparedAt: new Date().toISOString(), semesters: [] }
  let totalDiffs = 0

  const scrapedSems = scraped.semesters || []
  const matchedSheetKeys = new Set()
  for (const scrapedSem of scrapedSems) {
    const num = semesterNumber(scrapedSem.name)
    // Try exact name match first (so pre-med groups stay separate). If not found, fall back to numeric matching (Semester N).
    let matchedKey = null
    // flexible matching: try exact, then normalized name match, then numeric match
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

  // Also check for sheet semesters that didn't match any scraped semester (extra groups)
  // Report any sheet groups that weren't matched against a scraped semester (these are extra in the valid sheet)
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
  console.log('CURRICULUM COMPARISON REPORT')
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
    
    // Skip duplicate summer semester entries (they get merged by normalization)
    if (displayName.includes('Pre-Medical') && displayName.includes('Summer') && sem.name.includes('extra in valid')) {
      continue // already covered by the website's summer semester
    }
    
    console.log('='.repeat(60))
    console.log(`${displayName}`)
    console.log('='.repeat(60))
    
    if (sem.diffCount === 0) {
      console.log('\nNo differences\n')
      continue
    }
    
    // Group differences by type for cleaner output
    const codeMismatches = []
    const prereqMismatches = []
    const missing = []
    const extra = []
    const countMismatches = []
    
    for (const d of sem.diffs) {
      if (d.type === 'code-mismatch') {
        codeMismatches.push(d)
      } else if (d.type === 'prerequisite-mismatch') {
        prereqMismatches.push(d)
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
    
    // Print prerequisite mismatches
    if (prereqMismatches.length > 0) {
      console.log('\nPrerequisite mismatches:')
      for (const d of prereqMismatches) {
        const f = d.fetched || {}
        const v = d.valid || {}
        const code = f.code || v.code || '(no code)'
        const fPrereq = f.prerequisite || '(none)'
        const vPrereq = v.prerequisite || '(none)'
        console.log(`  ${code} – website='${fPrereq}' vs sheet='${vPrereq}'`)
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
  // persist machine-readable report for CI/archival
  try {
    const outdir = path.resolve('data')
    if (!fs.existsSync(outdir)) fs.mkdirSync(outdir, { recursive: true })
    fs.writeFileSync(path.resolve(outdir, 'compare_report.json'), JSON.stringify(report, null, 2), 'utf8')
    console.log('\nWrote machine-readable report to data/compare_report.json')
  } catch (err) {
    console.error('Failed to write data/compare_report.json:', err && err.message ? err.message : err)
  }


  // attempt to email the report when differences exist
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

  // exit 0 if no diffs, else exit 1
  process.exit(totalDiffs === 0 ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('compare_courses.js')) {
  main()
}
