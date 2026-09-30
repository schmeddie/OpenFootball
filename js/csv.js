// Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF).
(function (root) {
  const OF = (root.OF = root.OF || {});

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    if (text.charCodeAt(0) === 0xfeff) i = 1; // strip BOM
    const n = text.length;
    for (; i < n; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    if (!rows.length) return [];
    const header = rows[0];
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const cells = rows[r];
      if (cells.length === 1 && cells[0] === '') continue;
      const obj = {};
      for (let c = 0; c < header.length; c++) obj[header[c]] = cells[c] !== undefined ? cells[c] : '';
      out.push(obj);
    }
    return out;
  }

  OF.parseCSV = parseCSV;
})(typeof globalThis !== 'undefined' ? globalThis : this);
