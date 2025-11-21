#!/usr/bin/env node
(async () => {
  // Ensure a global File exists before any other modules load (prevents undici ReferenceError on some CI runners)
  try {
    if (typeof File === 'undefined') {
      try {
        const { File: NodeFile } = await import('buffer');
        if (NodeFile) globalThis.File = NodeFile;
      } catch (e) {
        // ignore; we'll let the main scraper attempt fallback if needed
      }
    }
    // import the real scraper
    await import('./scrape.js');
  } catch (err) {
    console.error(err);
    process.exit(2);
  }
})();
