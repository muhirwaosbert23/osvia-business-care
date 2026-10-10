const WIDTH = 92;
const LINES_PER_PAGE = 50;

function pdfEscape(value) {
  return String(value)
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/[()\\]/g, (ch) => `\\${ch}`);
}

function wrap(value, width) {
  const lines = [];
  for (const paragraph of String(value ?? "").split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      let piece = word;
      while (piece.length > width) {
        if (line) {
          lines.push(line);
          line = "";
        }
        lines.push(piece.slice(0, width));
        piece = piece.slice(width);
      }
      const next = line ? `${line} ${piece}` : piece;
      if (next.length > width) {
        lines.push(line);
        line = piece;
      } else {
        line = next;
      }
    }
    lines.push(line);
  }
  return lines;
}

export function buildPdf(title, rows, { footer = "OSVIA TECHNOLOGIES - Kampala, Uganda - osviatech.com" } = {}) {
  const lines = [];
  for (const row of rows) {
    if (row && typeof row === "object" && row.heading) lines.push({ text: row.heading, bold: true });
    else for (const text of wrap(row, WIDTH)) lines.push({ text, bold: false });
  }
  const pages = [];
  for (let i = 0; i < Math.max(lines.length, 1); i += LINES_PER_PAGE) pages.push(lines.slice(i, i + LINES_PER_PAGE));

  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = add(null);
  const pagesId = add(null);
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const boldId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const pageIds = [];

  pages.forEach((pageLines, index) => {
    const ops = ["BT", "/F2 15 Tf", "48 752 Td", `(${pdfEscape(title)}) Tj`, "/F1 9 Tf", "0 -16 Td", `(${pdfEscape(`Page ${index + 1} of ${pages.length}`)}) Tj`];
    let first = true;
    for (const line of pageLines) {
      ops.push(line.bold ? "/F2 11 Tf" : "/F1 10 Tf");
      ops.push(first ? "0 -24 Td" : "0 -13.5 Td");
      first = false;
      ops.push(`(${pdfEscape(line.text)}) Tj`);
    }
    ops.push("ET", "BT", "/F1 8 Tf", "48 30 Td", `(${pdfEscape(footer)}) Tj`, "ET");
    const stream = ops.join("\n");
    const contentId = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R /F2 ${boldId} 0 R >> >> >>`));
  });
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer << /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}
