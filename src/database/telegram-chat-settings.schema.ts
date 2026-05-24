export interface TelegramChatSettingsRow {
  sessionKey: string;
  voiceModeEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewTelegramChatSettingsRow {
  sessionKey: string;
  voiceModeEnabled?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}
