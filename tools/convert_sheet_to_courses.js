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
  // header rows include SNo in the 'Semester wise breakdown - BSDS' or __EMPTY equals 'Course \n Code'
  return obj['Semester wise breakdown - BSDS'] === 'SNo' || obj['__EMPTY'] && String(obj['__EMPTY']).toLowerCase().includes('course');
}

async function run() {
  const raw = await fs.readFile(inFile, 'utf8');
  const arr = JSON.parse(raw);

  const titleRow = arr.find(o => typeof o['Semester wise breakdown - BSDS'] === 'string' && /bachelor|data science|curriculum/i.test(o['Semester wise breakdown - BSDS'])) || {};
  const title = titleRow['Semester wise breakdown - BSDS'] || 'Curriculum (sheet)';

  const semesters = [];
  let current = null;

  for (const row of arr) {
    const s = row['Semester wise breakdown - BSDS'];
    // new semester marker
    if (typeof s === 'string' && /semester/i.test(s)) {
      current = { name: s.trim(), courses: [] };
      semesters.push(current);
      continue;
    }
    // pre-medical or special markers
    if (typeof s === 'string' && /pre-? ?medical/i.test(s)) {
      current = { name: s.trim(), courses: [] };
      semesters.push(current);
      continue;
    }

    // skip header rows
    if (isHeaderRow(row)) continue;

    // skip rows that only contain totals with no course code/title
    const code = row['__EMPTY'] ?? null;
    const titleText = row['__EMPTY_1'] ?? null;
    const teaching = row['__EMPTY_2'];
    const labs = row['__EMPTY_3'];

    if (!code && !titleText) continue;

    // if we don't yet have a current semester, create a default one
    if (!current) {
      current = { name: 'Unknown Semester', courses: [] };
      semesters.push(current);
    }

    // serial is sometimes in the 'Semester wise breakdown - BSDS' field when numeric
    const serialRaw = s;
    const serial = (serialRaw !== undefined && serialRaw !== null && String(serialRaw).trim() !== '' && !String(serialRaw).toLowerCase().includes('total')) ? String(serialRaw).trim() : null;

    const credits = makeCredits(teaching, labs);

    current.courses.push({
      serial,
      code: code ? String(code).trim() : null,
      title: titleText ? String(titleText).trim() : null,
      credits,
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
}

run().catch(err => { console.error(err); process.exit(2); });
