'use strict';
/**
 * A spreadsheet is read the way it was filled in.
 *
 * Every upload of scenarios comes through here, and nothing covered it: the
 * suites all went in as CSV or Markdown, so the .xlsx path — the one people
 * actually use — was the only part of the tool with no check on it at all.
 * It surfaced when the spreadsheet library had to be moved off the version
 * on npm, and there was no way to tell whether the move had broken reading.
 *
 * The workbooks here are built by hand rather than committed as binaries, so
 * what each check relies on is visible in the file that uses it.
 */
const JSZip = require('jszip');
const { extractScenarios } = require('../server/parse.js');

const checks = [];
const record = (n, ok, d) => checks.push({ n, ok, d });
const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A workbook of one sheet, from rows of plain values.
 *
 * Text goes in the shared string table and numbers go in as numbers, which
 * is what Excel itself writes and so what the reader has to cope with.
 */
async function workbook(rows, { sheetName = 'Scenarios' } = {}) {
  const strings = [];
  const idOf = (text) => {
    const at = strings.indexOf(text);
    if (at !== -1) return at;
    strings.push(text);
    return strings.length - 1;
  };

  const column = (n) => {
    let name = '';
    let left = n + 1;
    while (left > 0) {
      const rem = (left - 1) % 26;
      name = String.fromCharCode(65 + rem) + name;
      left = Math.floor((left - 1) / 26);
    }
    return name;
  };

  const sheetRows = rows.map((cells, r) => {
    const written = cells.map((value, c) => {
      if (value === '' || value === null || value === undefined) return '';
      const at = `${column(c)}${r + 1}`;
      if (typeof value === 'number') return `<c r="${at}"><v>${value}</v></c>`;
      return `<c r="${at}" t="s"><v>${idOf(String(value))}</v></c>`;
    }).join('');
    return `<row r="${r + 1}">${written}</row>`;
  }).join('');

  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
    + '</Types>');

  zip.folder('_rels').file('.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>');

  const xl = zip.folder('xl');
  xl.file('workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`);

  xl.folder('_rels').file('workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'
    + '</Relationships>');

  xl.folder('worksheets').file('sheet1.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetData>${sheetRows}</sheetData></worksheet>`);

  xl.file('sharedStrings.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}"`
    + ` uniqueCount="${strings.length}">`
    + strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')
    + '</sst>');

  return zip.generateAsync({ type: 'nodebuffer' });
}

(async () => {
  try {
    /* ---- the ordinary sheet: a header row and scenarios under it ---- */
    const plain = await workbook([
      ['S.No', 'Test Scenario', 'Type'],
      [1, 'Verify that the Inbox is migrated with every received message.', 'Positive'],
      [2, 'Verify that unread state survives the move to Outlook.', 'Positive'],
      [3, 'Verify that migration fails when the source account is suspended.', 'Negative'],
    ]);

    const read = extractScenarios(plain, 'Gmail to Outlook.xlsx');
    record('a spreadsheet of scenarios is read', read.scenarios.length === 3,
      `${read.scenarios.length} scenarios`);
    record('and the wording comes through whole',
      read.scenarios[0].scenario === 'Verify that the Inbox is migrated with every received message.',
      read.scenarios[0].scenario);
    record('and the numbers in the sheet are kept',
      read.scenarios.map((s) => s.sourceSno).join() === '1,2,3',
      read.scenarios.map((s) => s.sourceSno).join());
    record('and a column beside the scenario is carried',
      read.extraColumns.includes('Type') && read.scenarios[2].extra.Type === 'Negative',
      `${read.extraColumns.join('/')} — ${read.scenarios[2].extra.Type}`);

    /* ---- the header is not always the first row ---- */
    const titled = await workbook([
      ['Gmail to Outlook — In Scope'],
      [],
      ['S.No', 'Test Scenario'],
      [1, 'Verify that nested labels become nested folders.'],
      [2, 'Verify that drafts remain editable after migration.'],
    ]);

    const below = extractScenarios(titled, 'titled.xlsx');
    record('a title and a blank row above the header are stepped over',
      below.scenarios.length === 2, `${below.scenarios.length} scenarios`);
    record('and the title is not taken for a scenario',
      !below.scenarios.some((s) => /In Scope/.test(s.scenario)),
      below.scenarios[0].scenario.slice(0, 40));

    /* ---- a sheet with nothing in it says so rather than filing nothing ---- */
    let said = '';
    try { extractScenarios(await workbook([[]]), 'empty.xlsx'); } catch (err) { said = err.message; }
    record('an empty workbook is refused in words', /empty|No rows/i.test(said), said || 'no error');

    /* ---- .xls and .xlsm go down the same path as .xlsx ---- */
    const other = extractScenarios(plain, 'Gmail to Outlook.xlsm');
    record('.xlsm is read as a spreadsheet too', other.scenarios.length === 3,
      `${other.scenarios.length} scenarios`);

    /* ---- and a CSV of the same rows reads the same way, which is what
            says the two paths have not drifted apart ---- */
    const csv = Buffer.from([
      'S.No,Test Scenario,Type',
      '1,Verify that the Inbox is migrated with every received message.,Positive',
      '2,Verify that unread state survives the move to Outlook.,Positive',
      '3,Verify that migration fails when the source account is suspended.,Negative',
    ].join('\n'), 'utf8');

    const asCsv = extractScenarios(csv, 'same.csv');
    record('the same rows as CSV give the same scenarios',
      JSON.stringify(asCsv.scenarios.map((s) => s.scenario))
        === JSON.stringify(read.scenarios.map((s) => s.scenario)),
      `${asCsv.scenarios.length} vs ${read.scenarios.length}`);
  } catch (err) {
    record('threw', false, err.message);
  }

  console.log('\n--- a spreadsheet is read the way it was filled in ---');
  checks.forEach((c) => console.log((c.ok ? '  PASS  ' : '  FAIL  ') + c.n.padEnd(52) + ' ' + (c.d || '')));
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} FAILED` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
