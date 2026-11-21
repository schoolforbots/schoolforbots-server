import { type Kysely, sql } from 'kysely'

// The games of doudizhu the club service played, one row each, and one row of details for each student seat of a game
// (bots have none). A game's number is the club service's own (it goes on from the largest stored when the service
// starts), not a sequence. `record` is the game's record without what its own columns hold, with the rules it was
// played by. `ip` is where the seat played from: stored, never shown.
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('doudizhu_games')
    .addColumn('game_id', 'integer', (c) => c.primaryKey())
    .addColumn('room_id', 'text', (c) => c.notNull())
    .addColumn('started_at', 'timestamptz', (c) => c.notNull())
    .addColumn('ended_at', 'timestamptz', (c) => c.notNull())
    .addColumn('ranked', 'boolean', (c) => c.notNull())
    .addColumn('record', 'jsonb', (c) => c.notNull())
    .execute()

  await db.schema
    .createTable('doudizhu_game_players')
    .addColumn('game_id', 'integer', (c) => c.notNull().references('doudizhu_games.game_id'))
    .addColumn('seat', 'smallint', (c) => c.notNull())
    .addColumn('student_id', 'integer', (c) => c.notNull().references('students.id'))
    .addColumn('role', 'text')
    .addColumn('won', 'boolean', (c) => c.notNull())
    .addColumn('score', 'integer', (c) => c.notNull())
    .addColumn('multiplier', 'integer', (c) => c.notNull())
    .addColumn('ranked', 'boolean', (c) => c.notNull())
    .addColumn('ended_at', 'timestamptz', (c) => c.notNull())
    .addColumn('bombs', 'integer', (c) => c.notNull())
    .addColumn('rockets', 'integer', (c) => c.notNull())
    .addColumn('spring', 'boolean', (c) => c.notNull())
    .addColumn('anti_spring', 'boolean', (c) => c.notNull())
    .addColumn('timeouts', 'integer', (c) => c.notNull())
    .addColumn('trustee_moves', 'integer', (c) => c.notNull())
    .addColumn('illegal_moves', 'integer', (c) => c.notNull())
    .addColumn('ip', sql`inet`)
    .addPrimaryKeyConstraint('doudizhu_game_players_pkey', ['game_id', 'seat'])
    .addCheckConstraint('doudizhu_game_players_role_check', sql`role in ('landlord', 'farmer')`)
    .addCheckConstraint('doudizhu_game_players_seat_check', sql`seat between 0 and 2`)
    .execute()
  // A student's own games and stats, newest first.
  await db.schema
    .createIndex('doudizhu_game_players_student_id_ended_at')
    .on('doudizhu_game_players')
    .columns(['student_id', 'ended_at desc'])
    .execute()
  // A student's own games, newest first, a page at a time (`before` a game number).
  await db.schema
    .createIndex('doudizhu_game_players_student_id_game_id')
    .on('doudizhu_game_players')
    .columns(['student_id', 'game_id desc'])
    .execute()
  // The leaderboards: the ranked games of a period.
  await db.schema
    .createIndex('doudizhu_game_players_ranked_ended_at')
    .on('doudizhu_game_players')
    .columns(['ranked', 'ended_at'])
    .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  await db.schema.dropTable('doudizhu_game_players').execute()
  await db.schema.dropTable('doudizhu_games').execute()
}
