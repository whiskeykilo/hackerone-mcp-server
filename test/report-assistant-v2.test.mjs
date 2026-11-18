import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReportAssistantV2, reportAssistantV2 } from '../dist/h1v2.js';

const config = { projectId: 90, exchangeId: 269, username: 'test-user' };
const endpoint = 'https://hackerone.com/graphql';
const gid = Buffer.from('gid://hackerone/ReportIntent/123').toString('base64');
const draft = (overrides = {}) => ({
  id: gid, _id: '123', agent_version: 2, state: 'draft', updated_at: 'review-version',
  title: 'Original title', description: 'Original description', impact: 'Original impact',
  team: { id: 'team-gid', handle: 'example', name: 'Example' },
  severity: { rating: 'low', calculation_method: 'manual' },
  structured_scope: null, weakness: null, attachments: [], report: null,
  ...overrides,
});
const response = (data) => ({
  effective_url: endpoint, status_code: 200,
  response_preview: { text: JSON.stringify({ data }) },
});

// All transport operations terminate here. Unexpected calls fail rather than using a live client.
function harness({ username = config.username, exchange = {}, read = () => draft(), operation } = {}) {
  const calls = [];
  const requests = [];
  const client = new ReportAssistantV2(config, async (name, args) => {
    calls.push({ name, args });
    if (name === 'exchange_get') {
      assert.deepEqual(args, { project_id: 90, exchange_id: 269, body_bytes: 0 });
      return { exchanges: [{ exchange_id: 269, url: endpoint, method: 'POST', ...exchange }] };
    }
    assert.equal(name, 'reply_send');
    assert.equal(args.project_id, 90);
    assert.equal(args.base_exchange_id, 269);
    assert.equal(args.draft.url, endpoint);
    assert.equal(args.draft.method, 'POST');
    assert.equal(args.draft.inheritance, 'full_request');
    assert.deepEqual(args.draft.header_tombstones, ['content-length', 'content-type', 'host']);
    const body = args.draft.body_json;
    requests.push(args.draft);
    if (body?.query.includes('query H1V2Identity')) {
      assert.deepEqual(body.variables, {});
      return response({ me: { id: 'user-gid', username } });
    }
    if (body?.query.includes('query H1V2Intent(')) {
      assert.deepEqual(body.variables, { id: 123 });
      return response({ report_intent: await read() });
    }
    assert.ok(operation, 'Unexpected operation');
    return operation(args.draft);
  });
  return { client, calls, requests, writes: () => requests.filter((r) => r.body_override || /\bmutation\b/.test(r.body_json?.query)) };
}

for (const fields of [{ title: 'Changed' }, { severity_rating: 'none' }]) {
  test(`account mismatch blocks update ${Object.keys(fields)[0]}`, async () => {
    const h = harness({ username: 'different-user' });
    await assert.rejects(h.client.update('123', fields), /account mismatch/i);
    assert.equal(h.writes().length, 0);
    assert.equal(h.requests.length, 1);
  });
}

for (const exchange of [{ url: 'https://example.invalid/graphql' }, { method: 'GET' }]) {
  test(`invalid authentication exchange blocks requests: ${JSON.stringify(exchange)}`, async () => {
    const h = harness({ exchange });
    await assert.rejects(h.client.update('123', { title: 'Changed' }), /captured POST/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.requests.length, 0);
  });
}

test('V1 intents cannot be edited or migrated', async () => {
  const h = harness({ read: () => draft({ agent_version: 1 }) });
  await assert.rejects(h.client.update('123', { title: 'Changed' }), /only V2 intents/);
  assert.equal(h.writes().length, 0);
});

test('update sends only explicitly requested fields and verifies a separate readback', async () => {
  let saved = false;
  const h = harness({
    read: () => draft(saved ? { title: 'Changed' } : {}),
    operation: (request) => {
      assert.match(request.body_json.query, /mutation SaveReportIntent\(/);
      assert.deepEqual(request.body_json.variables, { input: { report_intent_id: gid, title: 'Changed' } });
      saved = true;
      return response({ saveReportIntent: { was_successful: true } });
    },
  });
  const result = await h.client.update('123', { title: 'Changed', impact: undefined });
  assert.equal(result.title, 'Changed');
  assert.equal(result.impact, 'Original impact');
  assert.equal(result.update_verified, true);
  assert.equal(h.requests.filter((r) => r.body_json?.query.includes('query H1V2Intent(')).length, 2);
  assert.equal(h.writes().length, 1);
});

test('manual none severity persists with both manual markers', async () => {
  let saved = false;
  const h = harness({
    read: () => draft(saved ? { severity: { rating: 'none', calculation_method: 'manual' } } : {}),
    operation: ({ body_json }) => {
      assert.deepEqual(body_json.variables.input, {
        report_intent_id: gid,
        severity_hash: { calculation_method: 'manual', type: 'manual', rating: 'none' },
      });
      saved = true;
      return response({ saveReportIntent: { was_successful: true } });
    },
  });
  assert.deepEqual((await h.client.update('123', { severity_rating: 'none' })).severity,
    { rating: 'none', calculation_method: 'manual' });
});

for (const field of ['title', 'description', 'impact', 'severity_rating']) {
  test(`save readback detects dropped ${field} without retry`, async () => {
    const h = harness({ operation: () => response({ saveReportIntent: { was_successful: true,
      report_intent: draft({ [field]: 'Changed' }) } }) });
    await assert.rejects(h.client.update('123', { [field]: field === 'severity_rating' ? 'none' : 'Changed' }), /save did not verify/);
    assert.equal(h.writes().length, 1);
  });
}

for (const verified of [true, false]) {
  test(`multipart uploads preserve binary bytes, map and references; readback ${verified ? 'matches' : 'fails'}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'h1v2-unit-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0xff, 0x80]);
    const second = Buffer.from([0, 1, 2, 0xfe]);
    await writeFile(join(directory, 'proof.png'), bytes);
    await writeFile(join(directory, 'second.png'), second);
    const attachments = [bytes, second].map((b, i) => ({
      id: `attachment-gid-${i}`, _id: String(456 + i), file_name: i ? 'second.png' : 'proof.png',
      file_size: b.length, content_type: 'image/png',
    }));
    let uploaded = false;
    const h = harness({
      read: () => draft({ attachments: uploaded && verified ? attachments : [] }),
      operation: async (request) => {
        assert.equal(request.body_json, undefined);
        assert.ok(Array.isArray(request.body_override));
        const header = request.header_overrides.find((h) => h.name === 'Content-Type');
        assert.match(header.value, /^multipart\/form-data; boundary=.+/);
        const form = await new Response(Uint8Array.from(request.body_override), {
          headers: { 'content-type': header.value },
        }).formData();
        const operations = JSON.parse(form.get('operations'));
        assert.match(operations.query, /mutation UploadReportIntentAttachments\(/);
        assert.deepEqual(operations.variables, { input: { report_intent_id: gid, files: [null, null] } });
        assert.deepEqual(JSON.parse(form.get('map')), {
          1: ['variables.input.files.0'], 2: ['variables.input.files.1'],
        });
        assert.deepEqual([...form.keys()].sort(), ['1', '2', 'map', 'operations']);
        for (const [i, expected] of [bytes, second].entries()) {
          const file = form.get(String(i + 1));
          assert.equal(file.name, attachments[i].file_name);
          assert.deepEqual(Buffer.from(await file.arrayBuffer()), expected);
        }
        uploaded = true;
        return response({ uploadReportIntentAttachments: { was_successful: true, attachments } });
      },
    });
    const result = h.client.upload('123', [join(directory, 'proof.png'), join(directory, 'second.png')]);
    if (verified) {
      const uploaded = await result;
      assert.deepEqual(uploaded.map((a) => a.reference), ['{F456}', '{F457}']);
      assert.deepEqual(uploaded.map((a) => a.id), ['456', '457']);
      assert.deepEqual(uploaded.map((a) => a.graphql_id), attachments.map((a) => a.id));
    } else {
      await assert.rejects(result, /attachments did not verify/);
    }
    assert.equal(h.writes().length, 1);
    assert.equal(h.requests.filter((r) => r.body_json?.query.includes('query H1V2Intent(')).length, 2);
  });
}

test('V2 pending drafts remain editable before checks, unlike V1 processing state', async () => {
  let saved = false;
  const h = harness({
    read: () => draft({ state: 'pending', ...(saved ? { title: 'Pending draft edit' } : {}) }),
    operation: () => { saved = true; return response({ saveReportIntent: { was_successful: true } }); },
  });
  assert.equal((await h.client.update('123', { title: 'Pending draft edit' })).title, 'Pending draft edit');
  assert.equal(h.writes().length, 1);
});

test('inline references must belong to the same draft before any save', async () => {
  const h = harness();
  await assert.rejects(h.client.update('123', { description: 'Screenshot: {F999}' }), /does not belong to this draft/);
  assert.equal(h.writes().length, 0);
});

test('inline screenshot references round-trip without creating a replacement draft', async () => {
  const attachments = [{ id: 'image-gid', _id: '456', file_name: 'proof.png', content_type: 'image/png' }];
  const description = 'Screenshot directly below:\n\n{F456}\n\nEnd of report.';
  let saved = false;
  const h = harness({
    read: () => draft({ attachments, ...(saved ? { description } : {}) }),
    operation: ({ body_json }) => {
      assert.deepEqual(body_json.variables.input, { report_intent_id: gid, description });
      saved = true;
      return response({ saveReportIntent: { was_successful: true } });
    },
  });
  const result = await h.client.update('123', { description });
  assert.equal(result.description, description);
  assert.equal(result.attachments[0].reference, '{F456}');
  assert.equal(h.writes().length, 1);
});

test('submission without confirmation performs zero calls', async () => {
  const h = harness();
  await assert.rejects(h.client.submit('123', false, 'review-version'), /confirm=true/);
  assert.equal(h.calls.length, 0);
});

test('stale reviewed timestamp never submits', async () => {
  const h = harness({ read: () => draft({ state: 'ready_to_submit', updated_at: 'new-version' }) });
  await assert.rejects(h.client.submit('123', true, 'review-version'), /changed since review/);
  assert.equal(h.writes().length, 0);
});

test('submission requires ready_to_submit, not just a matching timestamp', async () => {
  const h = harness();
  await assert.rejects(h.client.submit('123', true, 'review-version'), /not ready_to_submit/);
  assert.equal(h.writes().length, 0);
});

test('submission missing report ID remains unconfirmed and is never retried', async () => {
  const h = harness({
    read: () => draft({ state: 'ready_to_submit' }),
    operation: ({ body_json }) => {
      assert.match(body_json.query, /mutation SubmitReportIntentV2Mutation\(/);
      assert.deepEqual(body_json.variables, { input: { report_intent_id: gid } });
      return response({ submitReportIntent: { was_successful: true, report_intent: draft() } });
    },
  });
  await assert.rejects(h.client.submit('123', true, 'review-version'), /not confirmed.*no report ID returned.*may have succeeded/);
  assert.equal(h.writes().length, 1);
});

for (const failure of ['timeout', 'graphql', 'http']) {
  test(`write ${failure} is not retried`, async () => {
    const h = harness({ operation: () => {
      if (failure === 'timeout') throw new Error('ETIMEDOUT');
      if (failure === 'http') return { ...response({}), status_code: 503 };
      return { ...response({}), response_preview: { text: JSON.stringify({ errors: [{ message: 'Save failed' }] }) } };
    } });
    await assert.rejects(h.client.update('123', { title: 'Changed' }), /not retried|no retry/i);
    assert.equal(h.writes().length, 1);
    assert.equal(h.requests.length, 3);
  });
}

test('list forwards pagination and search without automatically fetching more pages', async () => {
  const h = harness({ operation: ({ body_json }) => {
    assert.match(body_json.query, /query H1V2History\(/);
    assert.match(body_json.query, /first: 25/);
    assert.deepEqual(body_json.variables, { search: 'example', after: 'previous-cursor' });
    return response({ me: { report_intents: { edges: [{ node: draft() }],
      pageInfo: { hasNextPage: true, endCursor: 'next-cursor' } } } });
  } });
  const result = await h.client.list('example', 'previous-cursor');
  assert.equal(result.has_next_page, true);
  assert.equal(result.end_cursor, 'next-cursor');
  assert.equal(result.results[0].id, '123');
  assert.equal(h.requests.length, 2);
});

test('list defaults optional pagination variables to null', async () => {
  const h = harness({ operation: ({ body_json }) => {
    assert.deepEqual(body_json.variables, { search: null, after: null });
    return response({ me: { report_intents: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
  } });
  assert.deepEqual(await h.client.list(), { results: [], has_next_page: false, end_cursor: null });
});

test('constructor rejects missing or invalid configuration without invoking transport', () => {
  for (const invalid of [
    { projectId: undefined }, { projectId: 0 }, { exchangeId: undefined }, { exchangeId: -1 },
    { projectId: 1.5 }, { username: '' }, { username: '   ' },
  ]) {
    assert.throws(() => new ReportAssistantV2({ ...config, ...invalid }, async () => {
      assert.fail('Invalid config must not invoke transport');
    }), /V2 requires/);
  }
});

test('optional factory reports missing configuration without changing the environment', {
  skip: ['H1_V2_HUNTPROXY_PROJECT_ID', 'H1_V2_HUNTPROXY_EXCHANGE_ID', 'H1_V2_USERNAME']
    .every((key) => process.env[key]) ? 'V2 environment is already configured' : false,
}, () => {
  assert.throws(() => reportAssistantV2(), /V2 is optional.*H1_V2_HUNTPROXY_PROJECT_ID/);
});
