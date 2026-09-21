// app/api/state/route.ts
// 入居者データ・業務連絡シート・往診日など「複数端末で共有したいデータ」を、
// Postgres（Neon等）の1行（id='singleton'）にJSONとしてまとめて保存・取得するAPI。
// 事前準備：プロジェクト直下の .env.local に以下の1行を追加してください
//   DATABASE_URL=postgres://xxxxx（Neonのダッシュボードで発行される接続文字列）
// .env.local は絶対に公開リポジトリにコミットしないでください（.gitignoreに含まれているか確認）。

import { NextRequest, NextResponse } from 'next/server';
import { Pool } from 'pg';

let pool: Pool | null = null;
function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

async function ensureTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id text PRIMARY KEY DEFAULT 'singleton',
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function GET() {
  try {
    if (!process.env.DATABASE_URL) {
      return NextResponse.json({ error: 'DATABASE_URLが設定されていません。.env.localファイルを確認してください。' }, { status: 500 });
    }
    await ensureTable();
    const { rows } = await getPool().query('SELECT data FROM app_state WHERE id = $1', ['singleton']);
    return NextResponse.json(rows[0]?.data ?? null);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || '不明なエラーが発生しました' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    if (!process.env.DATABASE_URL) {
      return NextResponse.json({ error: 'DATABASE_URLが設定されていません。.env.localファイルを確認してください。' }, { status: 500 });
    }
    const body = await req.json();
    await ensureTable();
    await getPool().query(
      `INSERT INTO app_state (id, data, updated_at) VALUES ('singleton', $1, now())
       ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()`,
      [JSON.stringify(body)]
    );
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || '不明なエラーが発生しました' }, { status: 500 });
  }
}
