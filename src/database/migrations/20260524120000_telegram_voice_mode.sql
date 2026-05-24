-- migrate:up
CREATE TABLE "telegram_chat_settings" (
  "session_key" varchar(255) PRIMARY KEY NOT NULL,
  "voice_mode_enabled" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- migrate:down
DROP TABLE IF EXISTS "telegram_chat_settings";
