import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ServerConfig } from '../../config.ts'
import { createRoutes } from '../../routes/index.ts'
import { openDb } from '../../store/db.ts'
import { listItems } from '../../store/items.ts'
import {
  LocalFileError,
  localIcsPayload,
  parseIcsRecords,
  readLocalFile,
} from '../../input/local-file.ts'

const calendar = {
  terms: [{ id: '2026-fall', name: '秋季', startMonday: '2026-09-07', weeks: 18 }],
}

const config = {
  host: '127.0.0.1',
  port: 5123,
  dataDir: ':memory:',
  promptsDir: resolve(import.meta.dirname, '../../../../prompts'),
  calendarPath: resolve(import.meta.dirname, '../../../../data/calendar.json'),
  token: null,
  llm: {
    text: { baseUrl: 'https://text.invalid/v1', apiKey: 'test', model: 'test' },
    vision: { baseUrl: 'https://vision.invalid/v1', apiKey: 'test', model: 'test' },
  },
  ruc: null,
} as ServerConfig

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:team-meeting-1',
  'DTSTART;TZID=Asia/Shanghai:20260907T140000',
  'DTEND;TZID=Asia/Shanghai:20260907T150000',
  'SUMMARY:组会',
  'LOCATION:明德主楼 0201',
  'RRULE:FREQ=WEEKLY;BYDAY=MO',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n')

test('local file reader bounds input, rejects symlinks, and preserves the original path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flowpal-local-file-'))
  try {
    const file = join(dir, 'notice.txt')
    await writeFile(file, '\uFEFF下周三交材料\n', 'utf8')
    const read = await readLocalFile(file)
    assert.equal(read.originalPath, file)
    assert.equal(read.kind, 'text')
    assert.equal(read.text, '下周三交材料\n')

    await assert.rejects(
      readLocalFile(file, { maxBytes: 2 }),
      (error: unknown) => error instanceof LocalFileError && error.code === 'too-large',
    )

    const link = join(dir, 'link.txt')
    await symlink(file, link)
    await assert.rejects(
      readLocalFile(link),
      (error: unknown) => error instanceof LocalFileError && error.code === 'symbolic-link',
    )
    await assert.rejects(
      readLocalFile(join(dir, 'archive.pdf')),
      (error: unknown) => error instanceof LocalFileError && error.code === 'unsupported-extension',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ICS parser maps UTC/Shanghai fields and keeps RFC recurrence/citations', () => {
  const records = parseIcsRecords(ICS, '2026-09-05T12:00:00+08:00')
  assert.equal(records.length, 1)
  assert.equal(records[0]?.source, 'local.ics')
  assert.equal(records[0]?.kind, 'calendar')
  assert.equal(records[0]?.externalId, 'local.ics:team-meeting-1')
  assert.equal(records[0]?.startsAt, '2026-09-07T14:00:00+08:00')
  assert.equal(records[0]?.endsAt, '2026-09-07T15:00:00+08:00')
  assert.equal(records[0]?.location, '明德主楼 0201')
  assert.equal(records[0]?.recurrence, 'FREQ=WEEKLY;BYDAY=MO')
  assert.equal(JSON.parse(localIcsPayload(records, '2026-09-05T12:00:00+08:00', ICS)).records.length, 1)
  assert.throws(
    () => parseIcsRecords(`${ICS}BEGIN:NOT-ICS\r\nEND:NOT-ICS\r\n`, '2026-09-05T12:00:00+08:00'),
    (error: unknown) => error instanceof LocalFileError && error.code === 'invalid-ics',
  )
})

test('file route deterministically imports ICS as a structured run while retaining raw path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flowpal-local-route-'))
  const db = openDb(':memory:')
  try {
    const file = join(dir, 'calendar.ics')
    await writeFile(file, ICS, 'utf8')
    const app = createRoutes(db, config, calendar)
    const response = await app.request('http://flowpal.test/api/fragments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'drop', rawType: 'file', rawBlobPath: file }),
    })
    assert.equal(response.status, 200)
    const body = await response.json() as any
    assert.equal(body.run.status, 'done')
    assert.equal(body.fragment.rawType, 'file')
    assert.equal(body.fragment.rawBlobPath, file)
    assert.match(body.fragment.rawText, /flowpal\.ruc\.external-records\.v1/)
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0].title, '组会')
    assert.equal(body.items[0].startsAt, '2026-09-07T14:00:00+08:00')
    assert.equal(body.items[0].rrule, 'FREQ=WEEKLY;BYDAY=MO')
    assert.equal(listItems(db).length, 1)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('malformed ICS remains an immutable failed fragment with its raw path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flowpal-local-invalid-'))
  const db = openDb(':memory:')
  try {
    const file = join(dir, 'broken.ics')
    const raw = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:missing-end\r\nEND:VCALENDAR\r\n'
    await writeFile(file, raw, 'utf8')
    const app = createRoutes(db, config, calendar)
    const response = await app.request('http://flowpal.test/api/fragments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'drop', rawType: 'file', rawBlobPath: file }),
    })
    assert.equal(response.status, 200)
    const body = await response.json() as any
    assert.equal(body.run.status, 'failed')
    assert.match(body.run.message, /ICS|原文已存/)
    assert.equal(body.fragment.rawBlobPath, file)
    assert.equal(body.fragment.rawText, raw)
    assert.equal(listItems(db).length, 0)
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})
