'use strict';
// These checks are authored for the user's later run; no API or browser is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const { publicWebUrl, webResponse } = require('../src/ai/web');

test('source links reject private destinations, credentials and active schemes', () => {
  for (const url of [
    'file:///C:/private.txt', 'javascript:alert(1)', 'data:text/html,hello', '/relative',
    'http://localhost/', 'https://service.local/', 'https://portal.internal/',
    'http://127.0.0.1/', 'http://2130706433/', 'http://169.254.169.254/',
    'http://10.0.0.1/', 'http://172.31.0.1/', 'http://192.168.1.1/', 'http://100.64.0.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'https://user:password@example.com/', 'https://example.com/?access_token=private',
  ]) assert.equal(publicWebUrl(url), '', url);
  assert.equal(publicWebUrl('https://example.com/news#section'), 'https://example.com/news#section');
});

test('a web response keeps final JSON and actual citation links, not tool preambles', () => {
  const response = webResponse([
    { type: 'text', text: 'I will look this up first.' },
    { type: 'server_tool_use', name: 'web_search' },
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.com/news', title: 'News' }] },
    { type: 'text', text: 'I will read the source.' },
    { type: 'server_tool_use', name: 'web_fetch' },
    { type: 'web_fetch_tool_result', content: { type: 'web_fetch_result', url: 'https://example.com/report', content: { type: 'document', title: 'Report' } } },
    { type: 'text', text: '{"say":"Current details', citations: [
      { type: 'web_search_result_location', url: 'https://example.com/news', title: 'News' },
      { type: 'web_search_result_location', url: 'javascript:alert(1)', title: 'Bad link' },
    ] },
    { type: 'text', text: '","actions":[]}', citations: [{ type: 'char_location', document_index: 0, document_title: 'Report' }] },
  ]);
  assert.deepEqual(JSON.parse(response.text), { say: 'Current details', actions: [] });
  assert.deepEqual(response.sources, [
    { type: 'web', url: 'https://example.com/news', title: 'News' },
    { type: 'web', url: 'https://example.com/report', title: 'Report' },
  ]);
  assert.equal(response.webUsed, true);
  assert.equal(response.successfulResults, 2);
});

test('failed lookups and uncited prose cannot manufacture verified source links', () => {
  const failed = webResponse([{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } }]);
  assert.equal(failed.webError, true);
  assert.equal(failed.successfulResults, 0);
  assert.deepEqual(failed.sources, []);
  assert.deepEqual(webResponse([{ type: 'text', text: 'I found https://example.com/' }]).sources, []);
});
