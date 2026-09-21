// app/api/summarize-report/route.ts
// ①状態報告・②VS・状態変化経過・医師指示管理の文章を受け取り、Claudeで簡潔な要約を作って返すAPI。
// このファイルは page.tsx とは別に、プロジェクトの以下のパスに新規作成してください：
//   app/api/summarize-report/route.ts
//
// 事前準備：プロジェクト直下に .env.local というファイルを作り、以下の1行を追加してください
//   ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxxxxxxx
// （Anthropic Console https://console.anthropic.com/ で取得したAPIキーを使います）
// .env.local は絶対に公開リポジトリにコミットしないでください（.gitignoreに含まれているか確認）。

import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { text } = await req.json();

    if (!text || typeof text !== 'string' || !text.trim()) {
      return NextResponse.json({ error: '要約する文章がありません' }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: 'ANTHROPIC_API_KEYが設定されていません。.env.localファイルを確認してください。' },
        { status: 500 }
      );
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: `以下は訪問看護の①状態報告・②VS・状態変化経過・医師指示管理の記載内容です。この内容を、後で時系列（既往歴）として一覧に並べた時に一目で分かるよう、2〜3文程度の簡潔な日本語でまとめてください。専門用語はそのまま使ってよいですが、余計な前置きや「まとめると」等の言葉は不要です。要約文だけを出力してください。\n\n---\n${text}\n---`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return NextResponse.json({ error: `Anthropic APIエラー: ${errText}` }, { status: response.status });
    }

    const data = await response.json();
    const summary = data?.content?.find((c: any) => c.type === 'text')?.text?.trim() || '';

    if (!summary) {
      return NextResponse.json({ error: '要約結果を取得できませんでした' }, { status: 500 });
    }

    return NextResponse.json({ summary });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || '不明なエラーが発生しました' }, { status: 500 });
  }
}
