import type { MatrixEvent } from './matrix-client.js';
import {
  MAX_MESSAGE_CHARS,
  buildSessionKey,
  editOf,
  inThread,
  parseInboundMessage,
  parseSessionKey,
  renderMessage,
  splitOversized,
} from './matrix-content.js';

function event(content: Record<string, unknown>): MatrixEvent {
  return {
    event_id: '$evt',
    type: 'm.room.message',
    sender: '@daniel:hs',
    origin_server_ts: 0,
    content,
  };
}

describe('parseInboundMessage', () => {
  it('parses a plain text message in the main timeline', () => {
    expect(
      parseInboundMessage(event({ msgtype: 'm.text', body: 'hi' })),
    ).toEqual({
      eventId: '$evt',
      sender: '@daniel:hs',
      kind: 'text',
      text: 'hi',
      threadRootId: undefined,
      replyToEventId: undefined,
    });
  });

  it('ignores edits', () => {
    const edit = event({
      msgtype: 'm.text',
      body: '* fixed',
      'm.relates_to': { rel_type: 'm.replace', event_id: '$orig' },
    });
    expect(parseInboundMessage(edit)).toBeUndefined();
  });

  it('records the thread root and ignores the thread reply fallback', () => {
    const message = parseInboundMessage(
      event({
        msgtype: 'm.text',
        body: 'in thread',
        'm.relates_to': {
          rel_type: 'm.thread',
          event_id: '$root',
          is_falling_back: true,
          'm.in_reply_to': { event_id: '$latest' },
        },
      }),
    );
    expect(message?.threadRootId).toBe('$root');
    expect(message?.replyToEventId).toBeUndefined();
  });

  it('records explicit replies and strips legacy quote fallbacks', () => {
    const message = parseInboundMessage(
      event({
        msgtype: 'm.text',
        body: '> <@assistant:hs> earlier\n\nmy answer',
        'm.relates_to': { 'm.in_reply_to': { event_id: '$quoted' } },
      }),
    );
    expect(message?.replyToEventId).toBe('$quoted');
    expect(message?.text).toBe('my answer');
  });

  it('treats body as a caption when filename is present', () => {
    const message = parseInboundMessage(
      event({
        msgtype: 'm.image',
        body: 'look at this',
        filename: 'photo.jpg',
        url: 'mxc://hs/abc',
        info: { mimetype: 'image/jpeg' },
      }),
    );
    expect(message).toMatchObject({
      kind: 'image',
      text: 'look at this',
      fileName: 'photo.jpg',
      mediaUrl: 'mxc://hs/abc',
      mimeType: 'image/jpeg',
    });
  });

  it('classifies image files as images and voice as audio', () => {
    expect(
      parseInboundMessage(
        event({
          msgtype: 'm.file',
          body: 'scan.png',
          url: 'mxc://hs/f',
          info: { mimetype: 'image/png' },
        }),
      )?.kind,
    ).toBe('image');
    expect(
      parseInboundMessage(
        event({
          msgtype: 'm.audio',
          body: 'Voice message',
          url: 'mxc://hs/v',
          'org.matrix.msc3245.voice': {},
        }),
      )?.kind,
    ).toBe('audio');
  });

  it('drops unsupported and empty messages', () => {
    expect(
      parseInboundMessage(event({ msgtype: 'm.location', body: 'here' })),
    ).toBeUndefined();
    expect(
      parseInboundMessage(event({ msgtype: 'm.text', body: '  ' })),
    ).toBeUndefined();
  });
});

describe('session keys', () => {
  it('round-trips room IDs that contain colons and ports', () => {
    const key = buildSessionKey('assistant', '!abc:hs.example:8448', '$root');
    expect(parseSessionKey(key)).toEqual({
      botName: 'assistant',
      roomId: '!abc:hs.example:8448',
      threadRootId: '$root',
    });
  });

  it('uses "main" for the room timeline', () => {
    const key = buildSessionKey('assistant', '!abc:hs', undefined);
    expect(key).toBe('matrix:assistant:!abc:hs:main');
    expect(parseSessionKey(key)?.threadRootId).toBeUndefined();
  });

  it('rejects keys from other providers', () => {
    expect(parseSessionKey('slack:bot:C1:main')).toBeUndefined();
  });
});

describe('outbound content', () => {
  it('renders markdown to HTML and escapes raw HTML', () => {
    const content = renderMessage('**bold** <script>x</script>');
    expect(content['body']).toBe('**bold** <script>x</script>');
    expect(content['formatted_body']).toContain('<strong>bold</strong>');
    expect(content['formatted_body']).not.toContain('<script>');
  });

  it('renders tables', () => {
    const content = renderMessage('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(content['formatted_body']).toContain('<table>');
  });

  it('adds a thread relation only when a thread is given', () => {
    const base = { msgtype: 'm.text', body: 'x' };
    expect(inThread(base, undefined)).toBe(base);
    expect(inThread(base, '$root')['m.relates_to']).toMatchObject({
      rel_type: 'm.thread',
      event_id: '$root',
    });
  });

  it('builds an m.replace edit carrying the new content', () => {
    const edit = editOf('$orig', renderMessage('new'));
    expect(edit['body']).toBe('* new');
    expect(edit['m.relates_to']).toEqual({
      rel_type: 'm.replace',
      event_id: '$orig',
    });
    expect((edit['m.new_content'] as Record<string, unknown>)['body']).toBe(
      'new',
    );
  });

  it('splits oversized text at a newline', () => {
    const line = 'x'.repeat(100);
    const text = Array.from({ length: 200 }, () => line).join('\n');
    const [head, rest] = splitOversized(text);
    expect(head.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(head.endsWith('x')).toBe(true);
    expect(`${head}\n${rest}`).toBe(text);
    expect(splitOversized('short')).toEqual(['short', '']);
  });
});
