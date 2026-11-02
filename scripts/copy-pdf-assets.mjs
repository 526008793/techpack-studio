import fs from "node:fs/promises";
for (const name of ["standard_fonts", "cmaps"])
  await fs.cp(
    `node_modules/pdfjs-dist/${name}`,
    `src/renderer/public/pdf-assets/${name}`,
    { recursive: true },
  );
