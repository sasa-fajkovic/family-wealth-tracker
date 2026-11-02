// RFC 4180 CSV encode/decode for DataPoint rows.
// Fixed schema: id,asset_id,year_month,value,notes,created_at,updated_at
// Handles quoted fields (commas / newlines in notes), double-quote escaping.

import type { DataPoint } from '../models/index.js'
import { pointSchema, ValidationError } from '../models/validation.js'

const HEADER = 'id,asset_id,year_month,value,notes,created_at,updated_at'

function quoteField(v: string): string {
  if (/[,"\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"'
  return v
}

// Character-by-character RFC 4180 state machine.
// Correctly handles: quoted fields, embedded commas, embedded newlines, escaped double-quotes.
function parseCsvRows(raw: string): string[][] {
  const rows: string[][] = []
  let fields: string[] = []
  let field = ''
  let inQuotes = false
  let closedQuote = false
  const n = raw.length

  for (let i = 0; i < n; i++) {
    const ch = raw[i]
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < n && raw[i + 1] === '"') {
          field += '"'
          i++ // consume escaped quote
        } else {
          inQuotes = false
          closedQuote = true
        }
      } else {
        field += ch
      }
    } else {
      if (closedQuote && ch !== ',' && ch !== '\n' && ch !== '\r') throw new ValidationError([{ row: rows.length + 1, field: 'record', message: 'Unexpected character after closing quote' }])
      if (ch === '"') {
        if (field !== '') throw new ValidationError([{ row: rows.length + 1, field: 'record', message: 'Unexpected quote in unquoted field' }])
        inQuotes = true
      } else if (ch === ',') {
        fields.push(field)
        field = ''
        closedQuote = false
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && i + 1 < n && raw[i + 1] === '\n') i++ // CRLF
        fields.push(field)
        rows.push(fields)
        fields = []
        field = ''
        closedQuote = false
      } else {
        field += ch
      }
    }
  }
  if (inQuotes) throw new ValidationError([{ row: rows.length + 1, field: 'record', message: 'Unterminated quoted field' }])
  // Last record — file may not end with newline
  if (field !== '' || fields.length > 0) {
    fields.push(field)
    rows.push(fields)
  }
  return rows
}

export function encodeDataPoints(points: DataPoint[]): string {
  const lines: string[] = [HEADER]
  for (const p of points) {
    lines.push([
      quoteField(p.id),
      quoteField(p.asset_id),
      quoteField(p.year_month),
      String(p.value),
      quoteField(p.notes ?? ''),
      quoteField(p.created_at),
      quoteField(p.updated_at),
    ].join(','))
  }
  return lines.join('\n') + '\n'
}

export function decodeDataPoints(raw: string): DataPoint[] {
  const trimmed = raw.trim()
  if (!trimmed) return []

  const rows = parseCsvRows(trimmed)
  if (rows.length === 0) return []

  const [headerRow, ...dataRows] = rows
  if (headerRow.join(',') !== HEADER) {
    throw new Error(
      `Unexpected CSV header: expected "${HEADER}", got "${headerRow.join(',')}"`,
    )
  }

  return dataRows
    .map((fields, index) => {
      if (fields.length !== 7) throw new ValidationError([{ row: index + 2, field: 'record', message: 'CSV row must have exactly 7 fields' }])
      const [id, asset_id, year_month, value, notes, created_at, updated_at] = fields
      if (value.trim() === '') throw new ValidationError([{ row: index + 2, record: id, field: 'value', message: 'CSV value must not be blank' }])
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())) throw new ValidationError([{ row: index + 2, record: id, field: 'value', message: 'CSV value must be a decimal number' }])
      const dp: DataPoint = { id, asset_id, year_month, value: Number(value), created_at, updated_at }
      if (notes !== '') dp.notes = notes
      const result = pointSchema.safeParse(dp)
      if (!result.success) throw new ValidationError(result.error.issues.map(issue => ({
        row: index + 2, record: id, field: issue.path.map(String).join('.') || 'record', message: issue.message,
      })))
      return result.data
    })
}
