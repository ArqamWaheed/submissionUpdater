#!/usr/bin/env node
(async () => {
  try {
    if (typeof File === 'undefined') {
      try {
        const { File: NodeFile } = await import('buffer');
        if (NodeFile) globalThis.File = NodeFile;
      } catch (e) {
      }
    }
    await import('./scrape.js');
  } catch (err) {
    console.error(err);
    process.exit(2);
  }
})();
