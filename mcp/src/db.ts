import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

export const sql = postgres(url, {
  max: 5,
  idle_timeout: 30,
  connect_timeout: 10,
  prepare: false,
});
