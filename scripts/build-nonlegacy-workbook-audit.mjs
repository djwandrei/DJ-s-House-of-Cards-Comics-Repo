import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const inputPath = path.join(root, "outputs", "nonlegacy-workbook-audit", "audit-data.json");
const outputDir = path.join(root, "outputs", "nonlegacy-workbook-audit");
const outputPath = path.join(outputDir, "nonlegacy_site_listing_workbook_audit.xlsx");

const data = JSON.parse(await fs.readFile(inputPath, "utf8"));
const workbook = Workbook.create();

function columnName(index) {
  let name = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function safeSheetName(value) {
  return String(value).replace(/[\\/?*:[\]]/g, " ").slice(0, 31).trim() || "Sheet";
}

function rowsToMatrix(rows) {
  const headers = rows.length ? Object.keys(rows[0]) : ["note"];
  const matrix = [headers];
  for (const row of rows) {
    matrix.push(headers.map((header) => {
      const value = row[header];
      if (value === undefined || value === null) return "";
      if (typeof value === "object") return JSON.stringify(value);
      return value;
    }));
  }
  return matrix;
}

function addSheet(name, rows, options = {}) {
  const sheet = workbook.worksheets.add(safeSheetName(name));
  sheet.showGridLines = false;
  const matrix = rowsToMatrix(rows.length ? rows : [{ note: "No rows found." }]);
  const lastCol = columnName(matrix[0].length - 1);
  const lastRow = matrix.length;
  sheet.getRange(`A1:${lastCol}${lastRow}`).values = matrix;
  const header = sheet.getRange(`A1:${lastCol}1`);
  header.format = {
    fill: { color: options.headerFill || "#14213D" },
    font: { bold: true, color: "#FFFFFF" },
    wrapText: true,
  };
  sheet.getRange(`A1:${lastCol}${lastRow}`).format.borders = {
    preset: "all",
    style: "thin",
    color: "#D8DEE9",
  };
  sheet.getRange(`A1:${lastCol}${lastRow}`).format.wrapText = true;
  sheet.freezePanes.freezeRows(1);
  if (lastRow > 1) {
    const table = sheet.tables.add(`A1:${lastCol}${lastRow}`, true, `${safeSheetName(name).replace(/\W+/g, "")}Table`);
    table.style = "TableStyleMedium2";
    table.showFilterButton = true;
  }
  const widths = matrix[0].map((header, colIndex) => {
    const maxLen = Math.max(
      String(header).length,
      ...matrix.slice(1, Math.min(matrix.length, 80)).map((row) => String(row[colIndex] ?? "").length)
    );
    return Math.min(46, Math.max(12, Math.ceil(maxLen * 1.15)));
  });
  widths.forEach((width, index) => {
    sheet.getRange(`${columnName(index)}:${columnName(index)}`).format.columnWidth = width;
  });
  return sheet;
}

function summaryRows() {
  const summaryMap = new Map(data.summary.map((row) => [row.metric, row.value]));
  const sourceTotals = data.sourceCounts || [];
  const issueRows = data.mismatches || [];
  const issueCounts = new Map();
  for (const row of issueRows) {
    issueCounts.set(row.issueType, (issueCounts.get(row.issueType) || 0) + 1);
  }
  const rows = [
    { area: "Inventory coverage", metric: "Workbook rows supplied", value: summaryMap.get("workbookRows"), note: "Rows across the three supplied workbooks, excluding Pricing Audit tabs." },
    { area: "Inventory coverage", metric: "Active Excel-backed site rows", value: summaryMap.get("activeExcelBackedSiteRows"), note: "Current active non-legacy site listings with workbook metadata." },
    { area: "Inventory coverage", metric: "Deleted Excel-backed local rows", value: summaryMap.get("deletedExcelBackedSiteRows"), note: "Rows still in local catalog data but marked deleted; these are not active site rows." },
    { area: "Matching", metric: "Uniquely matched active rows audited", value: summaryMap.get("uniqueMatchedActiveRowsAudited"), note: "Rows with one workbook row and one active site product by source + normalized title." },
    { area: "Matching", metric: "Workbook rows missing from active site", value: summaryMap.get("workbookRowsMissingFromActiveSite"), note: "Present in workbook, not active in current site catalog." },
    { area: "Matching", metric: "Workbook rows found only as locally deleted", value: summaryMap.get("workbookRowsFoundOnlyDeletedLocally"), note: "Present in workbook, but local catalog has only a deleted copy." },
    { area: "Matching", metric: "Active site rows not in supplied workbooks", value: summaryMap.get("activeSiteRowsNotFoundInWorkbooks"), note: "Active non-legacy site listings with no supplied workbook match." },
    { area: "Quality", metric: "Mismatch rows", value: summaryMap.get("mismatchRows"), note: "One row per field/attribute/image issue on uniquely matched records." },
    { area: "Quality", metric: "High severity mismatch rows", value: summaryMap.get("highSeverityMismatchRows"), note: "Price, title, photo, feature, missing-image, and key attribute issues." },
    { area: "Quality", metric: "Duplicate groups", value: summaryMap.get("duplicateGroups"), note: "Duplicate title/source groups in workbooks or active site." },
  ];
  for (const [issueType, count] of [...issueCounts.entries()].sort()) {
    rows.push({ area: "Issue type", metric: issueType, value: count, note: "" });
  }
  for (const row of sourceTotals) {
    rows.push({
      area: "Source",
      metric: row.source,
      value: row.activeSiteRows,
      note: `Workbook rows: ${row.workbookRows}; deleted local rows: ${row.deletedSiteRows}; site-only: ${row.activeSiteNotInWorkbook}; workbook-missing-active: ${row.workbookMissingFromActiveSite}`,
    });
  }
  return rows;
}

addSheet("Summary", summaryRows(), { headerFill: "#0B1F3A" });
addSheet("Source Counts", data.sourceCounts || []);
addSheet("Mismatches", data.mismatches || [], { headerFill: "#8A1C2E" });
addSheet("Workbook Missing Active", data.workbookMissingFromActiveSite || [], { headerFill: "#A15C00" });
addSheet("Workbook Only Deleted", data.workbookOnlyDeleted || [], { headerFill: "#6C3BAA" });
addSheet("Site Not In Workbooks", data.siteMissingFromWorkbooks || [], { headerFill: "#A15C00" });
addSheet("Duplicates", data.duplicates || [], { headerFill: "#8A1C2E" });
addSheet("Matched Samples", data.sampleMatchedRows || []);

await fs.mkdir(outputDir, { recursive: true });
const summaryInspect = await workbook.inspect({
  kind: "table",
  range: "Summary!A1:D18",
  include: "values",
  tableMaxRows: 20,
  tableMaxCols: 6,
  tableMaxCellChars: 120,
});
console.log(summaryInspect.ndjson);
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 300 },
  summary: "formula error scan",
});
console.log(errors.ndjson);
await workbook.render({ sheetName: "Summary", range: "A1:D18", scale: 1.5 });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
console.log(outputPath);
