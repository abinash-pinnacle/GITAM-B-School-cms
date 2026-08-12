/* ===== xlsx-lite — minimal, dependency-free .xlsx writer =====
   Produces a genuine Office Open XML workbook (not an HTML/CSV rename), so
   Excel / LibreOffice / Google Sheets open it without any format warning.

   Usage:
     XLSXLite.download('report.xlsx', [{
       name: 'Transactions',
       title: 'Library Transactions',      // optional big heading row
       subtitle: 'Generated on ...',       // optional grey line under it
       columns: [{ header:'Book', key:'book', width:32, type:'text' }, ...],
       rows: [{ book:'...', ... }],
       totals: { book:'TOTAL', copies: 42 } // optional highlighted last row
     }]);

   Column `type`: 'text' (default) | 'number' | 'date' (yyyy-mm-dd string)
   A row value may also be `{ v: <value>, tone: 'red'|'green'|'blue'|'amber' }`
   to colour that single cell.                                              */
(function (global) {
  'use strict';

  /* ---------------- CRC32 (for the ZIP entries) ---------------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------------- ZIP writer (stored / no compression) ---------------- */
  const enc = new TextEncoder();
  function zip(files) {
    const chunks = [], central = [];
    let offset = 0;
    files.forEach(f => {
      const nameBytes = enc.encode(f.name);
      const data = enc.encode(f.data);
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);      // local file header
      dv.setUint16(4, 20, true);              // version needed
      dv.setUint16(6, 0x0800, true);          // UTF-8 filename flag
      dv.setUint16(8, 0, true);               // stored
      dv.setUint16(10, 0, true); dv.setUint16(12, 0x2100, true); // time/date (fixed)
      dv.setUint32(14, crc, true);
      dv.setUint32(18, data.length, true);
      dv.setUint32(22, data.length, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);      // central directory header
      cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true); cv.setUint16(14, 0x2100, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);

      chunks.push(local, data);
      central.push(cd);
      offset += local.length + data.length;
    });

    const centralSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);

    return new Blob([...chunks, ...central, end],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  /* ---------------- XML helpers ---------------- */
  const x = (s) => String(s ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')   // chars Excel rejects
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

  function colLetter(n) {                       // 1 -> A, 27 -> AA
    let s = '';
    while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; }
    return s;
  }
  // Excel serial date (1900 system, with its historic leap-year quirk)
  function dateSerial(str) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str || ''));
    if (!m) return null;
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return Math.round(ms / 86400000) + 25569;
  }

  /* ---------------- style ids (must match styles.xml below) ---------------- */
  const S = {
    DEFAULT: 0, TITLE: 1, SUBTITLE: 2, HEADER: 3,
    TEXT: 4, NUMBER: 5, DATE: 6,
    RED: 7, GREEN: 8, BLUE: 9, AMBER: 10,
    TOTAL: 11, TOTAL_NUM: 12, LABEL: 13,
  };
  const TONE_STYLE = { red: S.RED, green: S.GREEN, blue: S.BLUE, amber: S.AMBER };

  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>
<fonts count="8">
<font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>
<font><b/><sz val="16"/><color rgb="FF14532D"/><name val="Calibri"/></font>
<font><i/><sz val="10"/><color rgb="FF6B7280"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFB91C1C"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF15803D"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF1D4ED8"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FF92400E"/><name val="Calibri"/></font>
</fonts>
<fills count="8">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1C7C3C"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFDBEAFE"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFE8F3EC"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border>
<left style="thin"><color rgb="FFD1D5DB"/></left><right style="thin"><color rgb="FFD1D5DB"/></right>
<top style="thin"><color rgb="FFD1D5DB"/></top><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="14">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="5" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="6" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="7" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="7" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  /* ---------------- one worksheet ---------------- */
  function sheetXml(sheet) {
    const cols = sheet.columns || [];
    const rows = sheet.rows || [];
    const nCols = Math.max(1, cols.length);
    const lastCol = colLetter(nCols);

    let r = 0;
    const out = [];
    const cell = (ci, ri, value, style, forceText) => {
      const ref = colLetter(ci) + ri;
      if (value === null || value === undefined || value === '') return `<c r="${ref}" s="${style}"/>`;
      if (!forceText && typeof value === 'number' && isFinite(value))
        return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${x(value)}</t></is></c>`;
    };

    if (sheet.title) {
      r++;
      out.push(`<row r="${r}" ht="26" customHeight="1">${cell(1, r, sheet.title, S.TITLE, true)}</row>`);
    }
    if (sheet.subtitle) {
      r++;
      out.push(`<row r="${r}">${cell(1, r, sheet.subtitle, S.SUBTITLE, true)}</row>`);
    }
    if (sheet.title || sheet.subtitle) { r++; out.push(`<row r="${r}"/>`); }

    const headerRow = r + 1;
    r = headerRow;
    out.push(`<row r="${r}" ht="24" customHeight="1">` +
      cols.map((c, i) => cell(i + 1, r, c.header, S.HEADER, true)).join('') + `</row>`);

    rows.forEach(row => {
      r++;
      out.push(`<row r="${r}">` + cols.map((c, i) => {
        let raw = row[c.key];
        let style;
        if (raw && typeof raw === 'object' && 'v' in raw) {
          style = TONE_STYLE[raw.tone];
          raw = raw.v;
        }
        if (c.type === 'date') {
          const ser = dateSerial(raw);
          return ser === null
            ? cell(i + 1, r, raw, style ?? S.NUMBER, true)
            : cell(i + 1, r, ser, style ?? S.DATE);
        }
        if (c.type === 'number') {
          const n = raw === '' || raw === null || raw === undefined ? '' : Number(raw);
          return cell(i + 1, r, (n === '' || isNaN(n)) ? raw : n, style ?? S.NUMBER);
        }
        return cell(i + 1, r, raw, style ?? (c.align === 'center' ? S.NUMBER : S.TEXT), true);
      }).join('') + `</row>`);
    });
    const lastDataRow = r;

    if (sheet.totals) {
      r++;
      out.push(`<row r="${r}" ht="20" customHeight="1">` + cols.map((c, i) => {
        const v = sheet.totals[c.key];
        const isNum = c.type === 'number' && v !== undefined && v !== '' && isFinite(Number(v));
        return cell(i + 1, r, isNum ? Number(v) : v, isNum ? S.TOTAL_NUM : S.TOTAL, !isNum);
      }).join('') + `</row>`);
    }

    const merges = [];
    if (sheet.title) merges.push(`A1:${lastCol}1`);
    if (sheet.subtitle) merges.push(`A${sheet.title ? 2 : 1}:${lastCol}${sheet.title ? 2 : 1}`);

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCol}${Math.max(r, 1)}"/>
<sheetViews><sheetView showGridLines="0" workbookViewId="0">
<pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/>
<selection pane="bottomLeft" activeCell="A${headerRow + 1}" sqref="A${headerRow + 1}"/>
</sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="16"/>
<cols>${cols.map((c, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${c.width || 16}" customWidth="1"/>`).join('')}</cols>
<sheetData>${out.join('')}</sheetData>
${rows.length ? `<autoFilter ref="A${headerRow}:${lastCol}${Math.max(lastDataRow, headerRow)}"/>` : ''}
${merges.length ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}
<pageMargins left="0.4" right="0.4" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>
<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0" paperSize="9"/>
</worksheet>`;
  }

  /* ---------------- workbook ---------------- */
  function build(sheets) {
    const safeName = (n, i) => (String(n || 'Sheet' + (i + 1))
      .replace(/[\\\/\?\*\[\]:]/g, ' ').slice(0, 31)) || ('Sheet' + (i + 1));

    const files = [
      { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
</Types>` },
      { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>` },
      { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) =>
        `<sheet name="${x(safeName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
      { name: 'xl/styles.xml', data: STYLES_XML },
    ];
    sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }));
    return zip(files);
  }

  function download(filename, sheets) {
    const blob = build(sheets);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = /\.xlsx$/i.test(filename) ? filename : filename + '.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  global.XLSXLite = { build, download };
})(window);
