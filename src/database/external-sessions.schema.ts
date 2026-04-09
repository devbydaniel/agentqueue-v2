export interface ExternalSessionRow {
  provider: string;
  sessionKey: string;
  filePath: string | null;
  botName: string | null;
  chatId: string | null;
  messageThreadId: number | null;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewExternalSessionRow {
  provider: string;
  sessionKey: string;
  filePath?: string | null;
  botName?: string | null;
  chatId?: string | null;
  messageThreadId?: number | null;
  lastActivityAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}
