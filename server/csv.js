export function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function csvLine(values) {
  return `${values.map(csvCell).join(",")}\r\n`;
}

export function streamCsv(res, header, fetchPage, mapRow, pageSize = 500) {
  res.write("\uFEFF");
  res.write(csvLine(header));
  let offset = 0;
  for (;;) {
    const rows = fetchPage(pageSize, offset);
    for (const row of rows) res.write(csvLine(mapRow(row)));
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  res.end();
}
