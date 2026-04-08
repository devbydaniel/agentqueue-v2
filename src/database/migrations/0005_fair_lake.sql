CREATE TABLE "linear_sessions" (
	"session_key" varchar(255) PRIMARY KEY NOT NULL,
	"file_path" varchar(1024) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
