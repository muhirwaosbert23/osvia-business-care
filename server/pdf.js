function pdfEscape(value) {
  return String(value).replace(/[()\\]/g, (ch) => `\\${ch}`).replace(/[^\x20-\x7E]/g, "?");
}

function wrap(value, width) {
  const words = String(value).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width) {
      if (line) lines.push(line);
      line = word.slice(0, width);
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

export function buildPdf(title, lines) {
  const body = ["BT", "/F1 16 Tf", "48 760 Td", `(${pdfEscape(title)}) Tj`];
  body.push("/F1 10 Tf");
  let first = true;
  for (const raw of lines) {
    for (const line of wrap(raw, 90)) {
      body.push(first ? "0 -22 Td" : "0 -14 Td");
      first = false;
      body.push(`(${pdfEscape(line)}) Tj`);
    }
  }
  body.push("ET");
  const stream = body.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
