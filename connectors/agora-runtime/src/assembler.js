// 可見脈絡組裝：把「觸發訊息」沿 reply_to(上文鏈)/replies(直接回覆)/relates(引用) 做「有界圖閉包」，
// 套用 max 則數 + 約略 token 預算 + 摘要降級 + 去重。這就是「降噪 + 有跡可循」的核心策略。
// 不依賴 LLM；純結構化檢索，輸出餵給 backend。

const approxTokens = (s) => Math.ceil((s || '').length / 4); // 粗估：4 字元≈1 token（中英混合夠用）

const shape = (m) => ({
  id: m.id, seq: m.seq, from: m.author_name, kind: m.author_kind,
  body: m.body, mentions: m.mentions || [], reply_to: m.reply_to || null,
  relates: m.relates || null, at: m.created_at,
});

// hub.context(id) -> { message, ancestors[], replies[], related[] }
export async function assembleContext(hub, triggerId, opts = {}) {
  const maxMessages = opts.maxMessages ?? 40;
  const tokenBudget = opts.tokenBudget ?? 6000;

  const ctx = await hub.context(triggerId);
  if (!ctx || !ctx.message) return { thread: [], related: [], trigger: null, dropped: 0, note: 'trigger_not_found' };

  // 1) 主脈絡 thread：祖先(上文鏈) + 觸發訊息 + 它的直接回覆，依 seq 排序
  const threadRaw = [...(ctx.ancestors || []), ctx.message, ...(ctx.replies || [])];
  // 2) related：被 relates 引用相關的訊息（去掉已在 thread 的）
  const threadIds = new Set(threadRaw.map((m) => m.id));
  const relatedRaw = (ctx.related || []).filter((m) => !threadIds.has(m.id));

  // 去重 + 排序
  const dedup = (arr) => {
    const seen = new Set(); const out = [];
    for (const m of arr) { if (seen.has(m.id)) continue; seen.add(m.id); out.push(m); }
    return out.sort((a, b) => a.seq - b.seq);
  };
  let thread = dedup(threadRaw).map(shape);
  let related = dedup(relatedRaw).map(shape);

  // 預算控制：先砍 related，再對 thread 做「保留最近 N + 前文摘要」降級
  let dropped = 0;
  const total = () => thread.length + related.length;
  while (total() > maxMessages && related.length) { related.pop(); dropped++; }

  let summaryNote = null;
  const usedTokens = () => [...thread, ...related].reduce((a, m) => a + approxTokens(m.body), 0);
  if (thread.length > maxMessages || usedTokens() > tokenBudget) {
    // 保留觸發訊息與其鄰近的最近段落；較舊的前文壓成一行摘要
    const keepRecent = Math.max(6, Math.floor(maxMessages / 2));
    if (thread.length > keepRecent) {
      const older = thread.slice(0, thread.length - keepRecent);
      thread = thread.slice(thread.length - keepRecent);
      dropped += older.length;
      const ids = older.map((m) => m.id.slice(0, 8)).join(',');
      summaryNote = `（前文 ${older.length} 則已省略以控管脈絡長度；如需可用 search_context 展開，ids: ${ids}）`;
    }
  }

  return {
    trigger: shape(ctx.message),
    thread,            // 有序、有界的主脈絡
    related,           // 引用相關（次要）
    dropped,           // 省略則數
    note: summaryNote, // 降級摘要說明（可放進 backend 輸入）
  };
}

export { approxTokens };
