'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/voice/reflex');

function sum(a) {
  if (!a) return null;
  switch (a.type) {
    case 'open_app': return 'open_app:' + a.app;
    case 'open_url': return 'open_url:' + a.url;
    case 'open_folder': return 'open_folder:' + a.name;
    case 'switch_to': return 'switch_to:' + a.app;
    case 'type_text': return 'type:' + a.text;
    case 'press_keys': return 'keys:' + a.keys.join('+');
    case 'window_op': return 'window:' + a.op;
    case 'media': return 'media:' + a.op + (a.level != null ? ':' + a.level : '');
    case 'scroll': return `scroll:${a.dir}:${a.amount}`;
    case 'click': return `click:${a.kind}:${a.name}`;
    case 'run_routine': return 'run_routine:' + a.name;
    case 'save_routine': return 'save_routine:' + a.name;
    case 'compose_email': return `email:${a.to}|${a.subject}|${a.body}`;
    case 'wait': return 'wait:' + a.ms;
    default: return a.type;
  }
}
const acts = (s, o) => parse(s, o).map((c) => sum(c.action));

test('the headline command: open Notepad, type hello', () => {
  assert.deepEqual(acts('open notepad type hello'), ['open_app:notepad', 'type:hello']);
  assert.deepEqual(acts('Open Notepad, type hello'), ['open_app:notepad', 'type:hello']);
  assert.deepEqual(acts('open notepad and type hello'), ['open_app:notepad', 'type:hello']);
  assert.deepEqual(acts('open notepad then type hello'), ['open_app:notepad', 'type:hello']);
});

test('the site demo: open notepad, new note, type hello', () => {
  assert.deepEqual(acts('open notepad, new note, type hello'), ['open_app:notepad', 'keys:ctrl+n', 'type:hello']);
  assert.deepEqual(acts('open notepad new note type hello'), ['open_app:notepad', 'keys:ctrl+n', 'type:hello']);
  assert.deepEqual(acts('open notepad then new note then type hello'), ['open_app:notepad', 'keys:ctrl+n', 'type:hello']);
});

test('typing keeps its words, and stops at the next command', () => {
  assert.deepEqual(acts('type hello world'), ['type:hello world']);
  assert.deepEqual(acts('type hello world and press enter'), ['type:hello world', 'keys:enter']);
  assert.deepEqual(acts('type hello world then hit enter'), ['type:hello world', 'keys:enter']);
  assert.deepEqual(acts('type salt and pepper'), ['type:salt and pepper']);
  assert.deepEqual(acts('Type hello.'), ['type:hello']);
  assert.deepEqual(acts('type hello, world'), ['type:hello, world']);
});

test('spoken punctuation becomes punctuation', () => {
  assert.deepEqual(acts('type dear sam comma thanks for the notes period'), ['type:dear sam, thanks for the notes.']);
  assert.deepEqual(acts('type first line new line second line'), ['type:first line\nsecond line']);
});

test('key chords', () => {
  assert.deepEqual(acts('press control s'), ['keys:ctrl+s']);
  assert.deepEqual(acts('press control shift t'), ['keys:ctrl+shift+t']);
  assert.deepEqual(acts('hit enter'), ['keys:enter']);
  assert.deepEqual(acts('press alt tab'), ['keys:alt+tab']);
  assert.deepEqual(acts('press windows d'), ['keys:win+d']);
  assert.deepEqual(acts('press f five'), ['keys:f5']);
  assert.deepEqual(acts('press page down'), ['keys:pagedown']);
  assert.deepEqual(acts('press control plus c'), ['keys:ctrl+c']);
});

test('named shortcuts only when they are the whole clause', () => {
  assert.deepEqual(acts('save'), ['keys:ctrl+s']);
  assert.deepEqual(acts('save this file'), ['keys:ctrl+s']);
  assert.deepEqual(acts('select all'), ['keys:ctrl+a']);
  assert.deepEqual(acts('copy that'), ['keys:ctrl+c']);
  assert.deepEqual(acts('select all then copy'), ['keys:ctrl+a', 'keys:ctrl+c']);
  assert.deepEqual(acts('copy the report to my desktop'), [null]);
  assert.deepEqual(acts('new tab'), ['keys:ctrl+t']);
  assert.deepEqual(acts('go back'), ['keys:alt+left']);
});

test('window and system actions', () => {
  assert.deepEqual(acts('minimize this window'), ['window:minimize']);
  assert.deepEqual(acts('maximize'), ['window:maximize']);
  assert.deepEqual(acts('close this window'), ['window:close']);
  assert.deepEqual(acts('show the desktop'), ['window:show_desktop']);
  assert.deepEqual(acts('switch windows'), ['keys:alt+tab']);
  assert.deepEqual(acts('snap left'), ['keys:win+left']);
  assert.deepEqual(acts('take a screenshot'), ['keys:win+shift+s']);
});

test('media and volume', () => {
  assert.deepEqual(acts('volume up'), ['media:vol_up']);
  assert.deepEqual(acts('turn it down'), ['media:vol_down']);
  assert.deepEqual(acts('mute'), ['media:mute']);
  assert.deepEqual(acts('pause'), ['media:play_pause']);
  assert.deepEqual(acts('play the music'), ['media:play_pause']);
  assert.deepEqual(acts('next song'), ['media:next']);
  assert.deepEqual(acts('skip this track'), ['media:next']);
  assert.deepEqual(acts('previous track'), ['media:prev']);
  assert.deepEqual(acts('set the volume to fifty'), ['media:volume_set:50']);
});

test('scrolling', () => {
  assert.deepEqual(acts('scroll down'), ['scroll:down:page']);
  assert.deepEqual(acts('scroll up a bit'), ['scroll:up:little']);
  assert.deepEqual(acts('scroll down a lot'), ['scroll:down:lot']);
  assert.deepEqual(acts('go to the top'), ['scroll:up:edge']);
  assert.deepEqual(acts('scroll to the bottom'), ['scroll:down:edge']);
});

test('web: search and go to', () => {
  assert.deepEqual(acts('search for cats'), ['open_url:https://www.google.com/search?q=cats']);
  assert.deepEqual(acts('search youtube for lofi hip hop'), ['open_url:https://www.youtube.com/results?search_query=lofi%20hip%20hop']);
  assert.deepEqual(acts('google weather in boston'), ['open_url:https://www.google.com/search?q=weather%20in%20boston']);
  assert.deepEqual(acts('search for hiking boots on amazon'), ['open_url:https://www.amazon.com/s?k=hiking%20boots']);
  assert.deepEqual(acts('go to youtube'), ['open_url:https://www.youtube.com']);
  assert.deepEqual(acts('open github.com'), ['open_url:https://github.com']);
  assert.deepEqual(acts('open example dot com'), ['open_url:https://example.com']);
  assert.deepEqual(acts('open chrome and go to youtube'), ['open_app:chrome', 'open_url:https://www.youtube.com']);
  assert.deepEqual(acts('go to reddit then scroll down'), ['open_url:https://www.reddit.com', 'scroll:down:page']);
});

test('apps, folders and windows by name', () => {
  assert.deepEqual(acts('open visual studio code'), ['open_app:visual studio code']);
  assert.deepEqual(acts('launch the calculator app'), ['open_app:calculator']);
  assert.deepEqual(acts('open downloads'), ['open_folder:downloads']);
  assert.deepEqual(acts('open my class notes folder', { folders: ['Class notes'] }), ['open_folder:class notes']);
  assert.deepEqual(acts('open class notes', { folders: ['Class notes'] }), ['open_folder:class notes']);
  assert.deepEqual(acts('switch to chrome'), ['switch_to:chrome']);
  assert.deepEqual(acts('go to notepad'), ['switch_to:notepad']);
});

test('polite and filler words are ignored', () => {
  assert.deepEqual(acts('can you please open notepad'), ['open_app:notepad']);
  assert.deepEqual(acts('hey clippy open notepad'), ['open_app:notepad']);
  assert.deepEqual(acts('then type hello'), ['type:hello']);
  assert.deepEqual(acts('okay now open notepad'), ['open_app:notepad']);
});

test('routines by voice', () => {
  assert.deepEqual(acts('run my routine'), ['run_routine:']);
  assert.deepEqual(acts('run my morning routine'), ['run_routine:morning']);
  assert.deepEqual(acts('start the study routine'), ['run_routine:study']);
  assert.deepEqual(acts('save that as a routine'), ['save_routine:']);
  assert.deepEqual(acts('save that as a routine called morning'), ['save_routine:morning']);
});

test('clicks, with the button word dropped', () => {
  assert.deepEqual(acts('click send'), ['click:single:send']);
  assert.deepEqual(acts('press the send button'), ['click:single:send']);
  assert.deepEqual(acts('click on the submit button'), ['click:single:submit']);
  assert.deepEqual(acts('double click the report icon'), ['click:double:report']);
});

test('new things', () => {
  assert.deepEqual(acts('create a new document'), ['keys:ctrl+n']);
  assert.deepEqual(acts('new window'), ['keys:ctrl+n']);
  assert.deepEqual(acts('new email'), ['email:||']);
  assert.deepEqual(acts('email sam about the lab report'), ['email:sam|the lab report|']);
  assert.deepEqual(acts('draft an email to sam saying thanks'), ['email:sam||thanks']);
});

test('waiting and cancelling', () => {
  assert.deepEqual(acts('wait two seconds'), ['wait:2000']);
  assert.deepEqual(acts('wait a second'), ['wait:1000']);
  assert.deepEqual(acts('cancel'), ['cancel']);
  assert.deepEqual(acts('never mind'), ['cancel']);
});

test('questions and requests are not actions', () => {
  assert.deepEqual(acts("what's the best way to open a new tab"), [null]);
  assert.deepEqual(acts('what time is it'), [null]);
  assert.deepEqual(acts('summarize my class notes'), [null]);
  assert.deepEqual(acts('explain this error'), [null]);
  assert.deepEqual(acts('how do i open notepad then type hello'), [null]);
});

test('an unknown clause between two actions keeps the actions', () => {
  const c = parse('open notepad then dance wildly then type hello');
  assert.deepEqual(c.map((x) => sum(x.action)), ['open_app:notepad', null, 'type:hello']);
  assert.equal(c[1].text, 'dance wildly');
});

test('partial transcripts parse as far as they go', () => {
  assert.deepEqual(acts('open'), [null]);
  assert.deepEqual(acts('open note'), ['open_app:note']);
  assert.deepEqual(acts('open notepad type'), ['open_app:notepad', null]);
  assert.deepEqual(acts(''), []);
});

test('each clause covers exactly its own words', () => {
  const c = parse('open notepad, new note, type hello');
  assert.deepEqual(c.map((x) => x.text), ['open notepad,', 'new note,', 'type hello']);
});
