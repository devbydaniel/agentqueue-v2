import { pgTable, varchar, timestamp } from 'drizzle-orm/pg-core';

export const linearSessions = pgTable('linear_sessions', {
  sessionKey: varchar('session_key', { length: 255 }).primaryKey(),
  filePath: varchar('file_path', { length: 1024 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type LinearSessionRow = typeof linearSessions.$inferSelect;
export type NewLinearSessionRow = typeof linearSessions.$inferInsert;
