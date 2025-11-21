# submissionUpdater — scraper

This repository contains a Node-based scraper (`src/scrape.js`) and a GitHub Actions workflow that runs the scraper on a schedule or manually.

How it works
- `src/scrape.js` first attempts a plain server-side fetch and parsing with `cheerio`. If the page is protected by JS/cloudflare, it falls back to a headless browser (Playwright) to render the page and then parses the resulting HTML.
- The scraper writes structured output to `data/courses.json` with the shape: { url, fetchedAt, title, semesters: [{ name, courses:[{serial,code,title,credits}] }] }.
- `.github/workflows/scrape.yml` runs `npm ci`, installs Playwright browsers, runs `npm run scrape`, and uploads `data/courses.json` as an artifact.

Run locally

1. Install dependencies and (if you want the fallback) Playwright browsers:

```bash
npm install
npx playwright install --with-deps
```

2. Run the scraper:

```bash
npm run scrape
```

Output will be written to `data/courses.json`.

Notes
- The script prefers a simple fetch/parsing path (faster). The Playwright fallback is used when the site requires JS to render content or presents a Cloudflare challenge.
- Running Playwright will download browsers (~200MB) and requires additional system dependencies in some environments; the workflow runs `npx playwright install --with-deps` to prepare them.
- Respect the target site's robots.txt and terms; don't over-schedule scraping.
