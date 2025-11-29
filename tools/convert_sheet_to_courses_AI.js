import fs from 'fs/promises';
import path from 'path';

const inFile = path.resolve('data', '(09222025)_BSDS_BSAI_curriculum_for_website (2025 onwards).json');
const outFile = path.resolve('data', 'courses_from_sheet_AI.json');

function makeCredits(teaching, labs) {
  if ((teaching === undefined || teaching === null || teaching === '') && (labs === undefined || labs === null || labs === '')) return null;
  const t = teaching !== undefined && teaching !== null ? String(teaching).trim() : '';
  const l = labs !== undefined && labs !== null ? String(labs).trim() : '';
  if (t && l) return `${t}+${l}`;
  return t || l || null;
}

function isHeaderRow(obj) {
  // Header rows have "SNo" or "Course Code" in __EMPTY or __EMPTY_1
  const val = obj['__EMPTY'] || obj['__EMPTY_1'] || '';
  return String(val).toLowerCase().includes('sno') || 
         String(val).toLowerCase().includes('course') ||
         String(val).toLowerCase().includes('subject');
}

async function run() {
  const raw = await fs.readFile(inFile, 'utf8');
  const arr = JSON.parse(raw);

  // Find title row (look for "BSAI" in __EMPTY field)
  const titleRow = arr.find(o => typeof o['__EMPTY'] === 'string' && /bsai|artificial intelligence/i.test(o['__EMPTY'])) || {};
  const title = titleRow['__EMPTY'] || 'Bachelor of Science in Artificial Intelligence (BSAI) Curriculum';

  const semesters = [];
  let current = null;

  for (const row of arr) {
    const firstCol = row['__EMPTY'];
    
    // New semester marker - check if __EMPTY contains "Semester" keyword
    if (typeof firstCol === 'string' && /semester\s*\d+/i.test(firstCol)) {
      current = { name: firstCol.trim(), courses: [] };
      semesters.push(current);
      continue;
    }
    
    // Pre-medical or special group markers
    if (typeof firstCol === 'string' && /pre-?\s*medical|summer\s*semester/i.test(firstCol)) {
      current = { name: firstCol.trim(), courses: [] };
      semesters.push(current);
      continue;
    }

    // Skip header rows
    if (isHeaderRow(row)) continue;

    // Extract course data from __EMPTY columns
    // __EMPTY = Serial/SNo
    // __EMPTY_1 = Course Code
    // __EMPTY_2 = Subject/Title
    // __EMPTY_3 = CHs Teaching
    // __EMPTY_4 = CHs Labs
    
    const serial = row['__EMPTY'];
    const code = row['__EMPTY_1'];
    const titleText = row['__EMPTY_2'];
    const teaching = row['__EMPTY_3'];
    const labs = row['__EMPTY_4'];
    const prereq = row['__EMPTY_5'];

    // Skip rows without code or title
    if (!code && !titleText) continue;
    
    // Skip total rows
    if (String(firstCol || '').toLowerCase().includes('total') || 
        String(titleText || '').toLowerCase().includes('total')) {
      continue;
    }

    // If we don't yet have a current semester, create a default one
    if (!current) {
      current = { name: 'Unknown Semester', courses: [] };
      semesters.push(current);
    }

    const credits = makeCredits(teaching, labs);
    
    // Clean serial number
    const cleanSerial = (serial !== undefined && serial !== null && String(serial).trim() !== '' && 
                        !String(serial).toLowerCase().includes('total') && 
                        !String(serial).toLowerCase().includes('semester')) 
                        ? String(serial).trim() : null;

    current.courses.push({
      serial: cleanSerial,
      code: code ? String(code).trim() : null,
      title: titleText ? String(titleText).trim() : null,
      credits,
      prerequisite: prereq ? String(prereq).trim() : null,
    });
  }

  const out = {
    sourceFile: path.basename(inFile),
    convertedAt: new Date().toISOString(),
    title,
    semesters,
  };

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, JSON.stringify(out, null, 2), 'utf8');
  console.log('Wrote', outFile);
  console.log(`Converted ${semesters.length} semesters`);
}

run().catch(err => { console.error(err); process.exit(2); });
