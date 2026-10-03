import MarkdownIt from 'markdown-it';
import type { MatrixEvent } from './matrix-client.js';

/**
 * Pure helpers for translating between Matrix event content and the
 * connector's own shapes: inbound message parsing, session keys, outbound
 * message/edit/thread content.
 */

// Matrix caps an event at 64 KiB including the HTML rendering and JSON
// escaping, so a single message carries well under half of that as markdown.
export const MAX_MESSAGE_CHARS = 16_000;

// Raw HTML in agent output is escaped, not passed through.
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

export type InboundKind = 'text' | 'image' | 'file' | 'audio';

export interface InboundMessage {
  eventId: string;
  sender: string;
  kind: InboundKind;
  /** Message text, or the caption of a media message. */
  text?: string;
  mediaUrl?: string;
  mimeType?: string;
  fileName?: string;
  /** Root event of the thread this message was sent in, if any. */
  threadRootId?: string;
  /** Event this message explicitly replies to (thread fallbacks excluded). */
  replyToEventId?: string;
}

interface Relation {
  rel_type?: string;
  event_id?: string;
  is_falling_back?: boolean;
  'm.in_reply_to'?: { event_id?: string };
}

const MEDIA_KINDS = new Map<string, InboundKind>([
  ['m.image', 'image'],
  ['m.file', 'file'],
  ['m.video', 'file'],
  ['m.audio', 'audio'],
]);

type MessageBase = Pick<
  InboundMessage,
  'eventId' | 'sender' | 'threadRootId' | 'replyToEventId'
>;

/** Parse an `m.room.message` event; undefined for edits and unsupported types. */
export function parseInboundMessage(
  event: MatrixEvent,
): InboundMessage | undefined {
  if (event.type !== 'm.room.message') return undefined;
  const relation = event.content['m.relates_to'] as Relation | undefined;
  if (relation?.rel_type === 'm.replace') return undefined;

  const base: MessageBase = {
    eventId: event.event_id,
    sender: event.sender,
    threadRootId:
      relation?.rel_type === 'm.thread' ? relation.event_id : undefined,
    replyToEventId: relation?.is_falling_back
      ? undefined
      : relation?.['m.in_reply_to']?.event_id,
  };
  return (
    parseTextContent(base, event.content) ??
    parseMediaContent(base, event.content)
  );
}

function parseTextContent(
  base: MessageBase,
  content: Record<string, unknown>,
): InboundMessage | undefined {
  const body = typeof content['body'] === 'string' ? content['body'] : '';
  switch (content['msgtype']) {
    case 'm.text':
    case 'm.notice': {
      const text = stripReplyFallback(body).trim();
      return text ? { ...base, kind: 'text', text } : undefined;
    }
    case 'm.emote':
      return { ...base, kind: 'text', text: `* ${body}` };
    default:
      return undefined;
  }
}

function parseMediaContent(
  base: MessageBase,
  content: Record<string, unknown>,
): InboundMessage | undefined {
  const msgtype = content['msgtype'];
  const kind =
    typeof msgtype === 'string' ? MEDIA_KINDS.get(msgtype) : undefined;
  const url = content['url'];
  if (!kind || typeof url !== 'string') return undefined;

  // Since Matrix 1.10 `body` is a caption when `filename` is also present.
  const body = typeof content['body'] === 'string' ? content['body'] : '';
  const filename =
    typeof content['filename'] === 'string' ? content['filename'] : undefined;
  const caption = filename && body && body !== filename ? body : undefined;
  const mimeType = (content['info'] as { mimetype?: string } | undefined)
    ?.mimetype;
  return {
    ...base,
    kind: kind === 'file' && mimeType?.startsWith('image/') ? 'image' : kind,
    text: caption,
    mediaUrl: url,
    mimeType,
    fileName: filename ?? body,
  };
}

/** Older clients prefix replies with `> <@user> quoted` lines and a blank line. */
function stripReplyFallback(body: string): string {
  if (!body.startsWith('> ')) return body;
  const lines = body.split('\n');
  const firstNonQuote = lines.findIndex((line) => !line.startsWith('>'));
  if (firstNonQuote === -1) return body;
  return lines.slice(firstNonQuote).join('\n');
}

export function buildSessionKey(
  botName: string,
  roomId: string,
  threadRootId: string | undefined,
): string {
  return `matrix:${botName}:${roomId}:${threadRootId ?? 'main'}`;
}

export interface ParsedSessionKey {
  botName: string;
  roomId: string;
  threadRootId: string | undefined;
}

/**
 * Inverse of buildSessionKey. Room IDs contain colons (`!id:server[:port]`)
 * but event IDs do not, so the thread is the segment after the last colon.
 */
export function parseSessionKey(key: string): ParsedSessionKey | undefined {
  const match = /^matrix:([^:]+):(.+):([^:]+)$/.exec(key);
  if (!match) return undefined;
  return {
    botName: match[1],
    roomId: match[2],
    threadRootId: match[3] === 'main' ? undefined : match[3],
  };
}

export function renderMessage(text: string): Record<string, unknown> {
  return {
    msgtype: 'm.text',
    body: text,
    format: 'org.matrix.custom.html',
    formatted_body: markdown.render(text).trim(),
  };
}

/** Attach a thread relation so the message lands inside the thread. */
export function inThread(
  content: Record<string, unknown>,
  threadRootId: string | undefined,
): Record<string, unknown> {
  if (!threadRootId) return content;
  return {
    ...content,
    'm.relates_to': {
      rel_type: 'm.thread',
      event_id: threadRootId,
      is_falling_back: true,
      'm.in_reply_to': { event_id: threadRootId },
    },
  };
}

/** Replace the content of an earlier message (`m.replace` edit). */
export function editOf(
  originalEventId: string,
  newContent: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...newContent,
    body: `* ${newContent['body'] as string}`,
    'm.new_content': newContent,
    'm.relates_to': { rel_type: 'm.replace', event_id: originalEventId },
  };
}

/**
 * Split text that exceeds MAX_MESSAGE_CHARS into a head that fits (cut at the
 * last newline where possible) and the remainder.
 */
export function splitOversized(text: string): [string, string] {
  if (text.length <= MAX_MESSAGE_CHARS) return [text, ''];
  const window = text.slice(0, MAX_MESSAGE_CHARS);
  const cut = window.lastIndexOf('\n');
  const at = cut > 0 ? cut : MAX_MESSAGE_CHARS;
  return [text.slice(0, at), text.slice(at).trimStart()];
}
