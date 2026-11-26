import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url, { alias: { '@': process.cwd() } });
const { GET } = await jiti.import('../app/api/sessions/[id]/download/route.ts');
const { SessionManager } = await import('@earendil-works/pi-coding-agent');
const { cacheSessionPath } = await jiti.import('./session-reader.ts');

test('download serves complete active-branch text or exact persisted bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-download-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const id = randomUUID();
  t.after(async () => {
    globalThis.__piSessions?.delete(id);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const dir = join(root, 'sessions', 'project');
  await mkdir(dir, { recursive: true });
  const timestamp = new Date().toISOString();
  const file = join(dir, `test_${id}.jsonl`);
  const rows = [{ type: 'session', version: 3, id, cwd: root, timestamp }];
  function message(id, parentId, role, content) {
    rows.push({ type: 'message', timestamp, id, parentId, message: { role, content } });
  }
  message('first', null, 'user', '问题');
  message('other', 'first', 'assistant', 'other branch');
  let leaf = 'first';
  for (let i = 0; i < 75; i++) {
    message(`tool${i}`, leaf, 'toolResult', 'private tool result');
    leaf = `tool${i}`;
  }
  message('reply', leaf, 'assistant', [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'one', textSignature: 'secret' }, { type: 'toolCall', arguments: { secret: true } }, { type: 'text', text: 'two' }]);
  const raw = Buffer.from(rows.map(row => JSON.stringify(row)).join('\r\n'));
  await writeFile(file, raw);
  const get = (query, session = id) => GET(new Request(`http://test/download?${query}`), { params: Promise.resolve({ id: session }) });
  for (const query of ['', 'format=html']) assert.equal((await get(query)).status, 400);
  for (const format of ['md', 'jsonl']) assert.equal((await get(`format=${format}`, randomUUID())).status, 404);
  const jsonl = await get('format=jsonl');
  assert.equal(jsonl.status, 200);
  assert.match(jsonl.headers.get('content-disposition'), /^attachment;.*\.jsonl/);
  assert.deepEqual(Buffer.from(await jsonl.arrayBuffer()), raw);
  const md = await get('format=md');
  assert.match(md.headers.get('content-type'), /^text\/markdown/);
  assert.equal(await md.text(), '## User\n\n问题\n\n## Assistant\n\none\n\ntwo\n');
  const sm = SessionManager.open(file);
  sm.branch('other');
  let running = false;
  globalThis.__piSessions.set(id, { sessionFile: file, isAlive: () => true, isRunning: () => running, inner: { sessionManager: sm } });
  const liveMarkdown = '## User\n\n问题\n\n## Assistant\n\nother branch\n';
  assert.equal(await (await get('format=md')).text(), liveMarkdown);

  const external = { type: 'message', id: 'external', parentId: 'reply', timestamp, message: { role: 'user', content: 'external write' } };
  await appendFile(file, `\n${JSON.stringify(external)}\n{"torn":`);
  assert.equal(await (await get('format=md')).text(), '## User\n\n问题\n\n## Assistant\n\none\n\ntwo\n\n## User\n\nexternal write\n');
  assert.equal(sm.getLeafId(), 'other', 'download never changes the live leaf');
  running = true;
  assert.equal(await (await get('format=md')).text(), liveMarkdown);

  const replacement = `${file}.tmp`;
  await writeFile(replacement, JSON.stringify({ ...rows[0], id: randomUUID() }) + '\nprivate replacement');
  // A response already opened on the old file must not follow the path after replacement.
  const opened = await get('format=jsonl');
  const oldBytes = await readFile(file);
  await rename(replacement, file);
  assert.deepEqual(Buffer.from(await opened.arrayBuffer()), oldBytes);
  for (const format of ['md', 'jsonl']) {
    const response = await get(`format=${format}`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Session not found' });
  }

  globalThis.__piSessions.delete(id);
  assert.equal((await get('format=md')).status, 404, 'the cached path alone cannot authorize the replacement');
  await writeFile(file, '');
  cacheSessionPath(id, file);
  for (const format of ['md', 'jsonl']) assert.equal((await get(`format=${format}`)).status, 404);
  assert.equal((await readFile(file)).length, 0, 'must not initialize an empty file');
  await rm(file);
  await mkdir(file);
  for (const format of ['md', 'jsonl']) assert.equal((await get(`format=${format}`)).status, 404);
});

test('legacy Markdown migrates in memory and keeps inherited text, displaying skills as commands', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-download-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const id = randomUUID();
  const file = join(dir, `${id}.jsonl`);
  const timestamp = new Date().toISOString();
  const raw = [
    { type: 'session', id, cwd: dir, timestamp }, // v1: omitted version and no tree ids
    { type: 'message', timestamp, message: { role: 'user', content: 'inherited question' } },
    { type: 'message', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: 'inherited answer' }] } },
    { type: 'custom_message', timestamp, customType: 'pi-web:side-boundary', display: false, content: 'hidden boundary' },
    { type: 'message', timestamp, message: { role: 'user', content: [
      { type: 'text', text: '<skill name="review" location="/skills/review/SKILL.md">' },
      { type: 'text', text: 'References are relative to /skills/review.\r\n\r\nprivate expanded skill\r\n</skill>\r\n\r\nmy args' },
    ] } },
  ].map(row => JSON.stringify(row)).join('\r\n');
  await writeFile(file, raw);
  cacheSessionPath(id, file);
  const get = (format) => GET(new Request(`http://test/download?format=${format}`), { params: Promise.resolve({ id }) });
  assert.equal(await (await get('md')).text(), '## User\n\ninherited question\n\n## Assistant\n\ninherited answer\n\n## User\n\n/skill:review my args\n');
  assert.equal(await readFile(file, 'utf8'), raw);
  assert.equal(await (await get('jsonl')).text(), raw);
});
