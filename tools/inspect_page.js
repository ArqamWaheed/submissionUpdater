import { chromium } from 'playwright';
import fs from 'fs/promises';
const url = 'https://seecs.nust.edu.pk/program/bachelor-of-science-in-data-science-for-fall-2025-onwards';
(async ()=>{
  const browser = await chromium.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36', extraHTTPHeaders: { 'Accept-Language':'en-US,en;q=0.9' } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 120000 });
  await page.waitForLoadState('networkidle', { timeout: 120000 });
  const content = await page.content();
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile('data/debug_page.html', content, 'utf8');
  console.log('Wrote data/debug_page.html');
  // Print headings
  const headings = await page.$$eval('h1,h2,h3,h4,h5,h6', els => els.map(e=>e.innerText.trim()).filter(Boolean));
  console.log('Headings:', headings.slice(0,40));
  // Find probable course codes
  const codes = await page.$$eval('*', els => Array.from(els).map(e=>e.innerText).filter(Boolean).join('\n').match(/[A-Z]{2,}\s*-?\s*\d{2,4}/g) || []);
  console.log('Found codes sample:', Array.from(new Set(codes)).slice(0,50));
  await context.close();
  await browser.close();
})();