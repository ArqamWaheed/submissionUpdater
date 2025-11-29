import fs from 'fs/promises';
import path from 'path';
import * as cheerio from 'cheerio';

// Some environments (certain Node/undici combinations) expect a global File
// web class to exist. On some CI runners this is missing and causes undici
// to throw: "ReferenceError: File is not defined". Provide a lightweight
// polyfill from the Node `buffer` module when available.
if (typeof File === 'undefined') {
  try {
    const { File: NodeFile } = await import('buffer');
    if (NodeFile) globalThis.File = NodeFile;
  } catch (e) {
    // ignore — fallback will be attempted by Playwright if needed
  }
}

// Target page to scrape
const url = 'https://seecs.nust.edu.pk/program/bachelor-of-science-in-data-science-for-fall--2023-fall---2024-entiers';
// Helper: detect course code and credits
const codeRegex = /[A-Z]{2,}\s*-?\s*\d{2,4}/;
const creditsRegex = /(?:\b|\()([0-9]+(?:\.[0-9]+)?)(?:\s*Cr|\s*credit|\)|$)/i;

function parseCourseFromCells(cells) {
  let serial = null; let code = null; let credits = null; let prerequisite = null; let title = '';
  // Table structure: No | Code | Title | Credit Hours | Related SDGs | Pre-requisites | (empty column)
  const first = cells[0] || '';
  const hasSerial = /^\d+$/.test(first);
  const offset = hasSerial ? 1 : 0;
  if (cells.length >= offset + 3) {
    if (hasSerial) serial = first.trim();
    code = (cells[offset] || '').trim() || null;
    title = (cells[offset + 1] || '').trim() || null;
    const creditCell = (cells[offset + 2] || '').trim();
    credits = creditCell || null; // keep as string like '3+1' when available
    // Prerequisite is at column 5 (cells[5] when hasSerial, which is offset+4)
    if (cells.length >= offset + 5) {
      const prereqCell = (cells[offset + 4] || '').trim();
      prerequisite = prereqCell || null;
    }
    return { serial, code, title, credits, prerequisite };
  }

  // Fallback: try to extract by scanning pieces
  const remaining = [];
  for (const c of cells) {
    const t = c.trim();
    if (!t) continue;
    if (!serial && /^\d+$/.test(t)) { serial = t; continue; }
    if (!code && codeRegex.test(t)) { code = (t.match(codeRegex)||[''])[0].replace(/\s+/g,' ').trim(); continue; }
    // credits fallback: keep first numeric-like token
    if (!credits && creditsRegex.test(t)) { credits = (t.match(creditsRegex)||[])[1]; continue; }
    remaining.push(t);
  }
  title = remaining.join(' - ').trim();
  return { serial, code, title: title || null, credits: credits ? Number(credits) : null, prerequisite };
}

function parseCourseFromLine(line) {
  const s = line.trim();
  let serial = null, code = null, credits = null, prerequisite = null, title = null;
  const serialMatch = s.match(/^\s*(\d+)\s*[.)-]?\s*/);
  let rest = s;
  if (serialMatch) { serial = serialMatch[1]; rest = s.slice(serialMatch[0].length); }
  const codeMatch = rest.match(codeRegex);
  if (codeMatch) { code = codeMatch[0].replace(/\s+/g,' ').trim(); rest = rest.replace(codeMatch[0], ''); }
  const creditsMatch = rest.match(creditsRegex);
  if (creditsMatch) { credits = Number(creditsMatch[1]); rest = rest.replace(creditsMatch[0], ''); }
  title = rest.replace(/[-–—]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!title) title = null;
  return { serial, code, title, credits, prerequisite };
}

function extractSemesters($) {
  const semesterHeadings = $('h1,h2,h3,h4,h5,h6').toArray().filter(h => /semester/i.test($(h).text()));
  const semesters = [];
  
  // Try method 1: explicit semester headings
  for (const h of semesterHeadings) {
    const semName = $(h).text().trim();
    const courses = [];
    let sib = $(h).next();
    while (sib && sib.length) {
      const tag = sib[0].tagName ? sib[0].tagName.toLowerCase() : null;
      if (tag && /^h[1-6]$/.test(tag) && /semester/i.test(sib.text())) break;
      if (tag === 'table') {
        $(sib).find('tr').each((_, tr) => {
          const cols = $(tr).find('th,td').toArray().map(td => $(td).text().trim()).filter(Boolean);
          if (cols.length >= 2) {
            const parsed = parseCourseFromCells(cols);
            if (parsed.code || parsed.title) courses.push(parsed);
          }
        });
      }
      if (tag === 'ul' || tag === 'ol') {
        $(sib).find('li').each((_, li) => {
          const text = $(li).text().trim();
          const parsed = parseCourseFromLine(text);
          if (parsed.code || parsed.title) courses.push(parsed);
        });
      }
      if (tag === 'p' || tag === 'div') {
        const lines = $(sib).text().split(/\n|\r/).map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          if (!/\d+/.test(line) && !codeRegex.test(line)) continue;
          const parsed = parseCourseFromLine(line);
          if (parsed.code || parsed.title) courses.push(parsed);
        }
      }
      sib = sib.next();
    }
    const seen = new Set();
    const deduped = [];
    for (const c of courses) {
      const key = `${c.code||''}||${c.title||''}`;
      if (!seen.has(key)) { seen.add(key); deduped.push(c); }
    }
    semesters.push({ name: semName, courses: deduped });
  }
  
  // Method 2: tables with thead semester names
  $('table').each((_, table) => {
    const headTh = $(table).find('thead tr th').first();
    const headText = headTh.text().trim();
    if (!/semester/i.test(headText)) return;
    if (semesters.some(s => s.name === headText)) return;
    const courses = [];
    $(table).find('tbody tr').each((__, tr) => {
      const serial = $(tr).find('th[scope="row"]').first().text().trim();
      const tds = $(tr).find('td').toArray().map(td => $(td).text().trim());
      const cells = [];
      if (serial) cells.push(serial);
      cells.push(...tds);
      if (cells.length) {
        const parsed = parseCourseFromCells(cells);
        if (parsed.code || parsed.title) courses.push(parsed);
      }
    });
    const seen = new Set();
    const deduped = [];
    for (const c of courses) {
      const key = `${c.code||''}||${c.title||''}`;
      if (!seen.has(key)) { seen.add(key); deduped.push(c); }
    }
    semesters.push({ name: headText, courses: deduped });
  });
  
  // Method 3: pages without explicit semester headers - extract all tables and number them
  if (semesters.length === 0) {
    let semesterIndex = 1;
    $('table').each((_, table) => {
      const courses = [];
      let hasTotal = false;
      
      $(table).find('tr').each((__, tr) => {
        const cols = $(tr).find('th,td').toArray().map(td => $(td).text().trim());
        
        // Skip empty rows
        if (cols.filter(Boolean).length === 0) return;
        
        // Check if this is a Total row
        const rowText = cols.join(' ').toLowerCase();
        if (rowText.includes('total') || rowText.includes('grand total')) {
          hasTotal = true;
          return; // skip the total row itself
        }
        
        // Try to parse as course
        const parsed = parseCourseFromCells(cols);
        // Filter out rows without a valid course code (skip total rows and other non-course entries)
        if ((parsed.code || parsed.title) && !rowText.includes('total')) {
          courses.push(parsed);
        }
      });
      
      // Only add if we found courses and it looks like a semester table (has Total row)
      if (courses.length > 0 && hasTotal) {
        const seen = new Set();
        const deduped = [];
        for (const c of courses) {
          const key = `${c.code||''}||${c.title||''}`;
          if (!seen.has(key)) { seen.add(key); deduped.push(c); }
        }
        semesters.push({ name: `Semester-${semesterIndex}`, courses: deduped });
        semesterIndex++;
      }
    });
  }
  
  return semesters;
}

async function scrape() {
  console.log(`Fetching ${url}`);
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }
  const html = await res.text();
  const $ = cheerio.load(html);
  const metaTitle = ($('title').first().text() || '').trim();
  const semesters = extractSemesters($);
  if (!semesters || semesters.length === 0) {
    throw new Error('No semester blocks found in fetched HTML');
  }
  const result = { url, fetchedAt: new Date().toISOString(), title: metaTitle, semesters };
  const outDir = path.resolve('data');
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, 'courses.json');
  await fs.writeFile(outFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(`Wrote ${outFile}`);
  console.log(JSON.stringify({ url: result.url, fetchedAt: result.fetchedAt, semesters: result.semesters.length }, null, 2));
}

// If semesters array is empty (often due to Cloudflare or JS-rendered content),
// try again using a headless browser (Playwright) to execute page JavaScript.
async function scrapeWithFallback() {
  try {
    await scrape();
    return;
  } catch (err) {
    console.warn('Initial fetch/parse failed, will try headless browser fallback:', err.message || err);
  }

  // dynamic import playwright to avoid requiring it if not needed
  try {
    const { chromium } = await import('playwright');
    console.log('Launching headless browser (Playwright)...');
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' }
    });
    const page = await context.newPage();
  // CF JS challenges can take longer; allow more time
  await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForLoadState('networkidle', { timeout: 120000 });
    const content = await page.content();
  await context.close();
  await browser.close();

    const $2 = cheerio.load(content);

    // Reuse extraction logic
    const semesters2 = extractSemesters($2);

    const result2 = {
      url,
      fetchedAt: new Date().toISOString(),
      title: ($2('title').first().text() || '').trim(),
      semesters: semesters2,
    };

    const outDir = path.resolve('data');
    await fs.mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, 'courses.json');
    await fs.writeFile(outFile, JSON.stringify(result2, null, 2), 'utf8');
    console.log(`Wrote ${outFile} (from Playwright)`);
    console.log(JSON.stringify({ url: result2.url, fetchedAt: result2.fetchedAt, semesters: result2.semesters.length }, null, 2));
    return;
  } catch (err) {
    console.error('Playwright fallback failed:', err);
    process.exit(2);
  }
}

scrapeWithFallback();
