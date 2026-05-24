// 確定性測試用 backend：不接 LLM，但「真的」讀組裝好的脈絡並引用之，產出帶出處的回覆。
// 用來在沒有真實 agent 的環境端對端驗證整條迴圈（這不是 echo——它會根據脈絡組裝內容並標出處）。
export function createMockBackend() {
  return {
    kind: 'mock',
    async respond({ self, trigger, context, members }) {
      const seen = context.thread.map((m) => `#${m.seq}${m.from}`).join(' ');
      const usedIds = context.thread.filter((m) => m.id !== trigger.id).map((m) => m.id);
      const relatedIds = context.related.map((m) => m.id);
      const who = trigger.from;
      const lines = [
        `（mock backend）我是 ${self.name}，收到 ${who} 的 @：「${trigger.body}」。`,
        `我看見的可見脈絡（${context.thread.length} 則主線${context.related.length ? ` + ${context.related.length} 則引用` : ''}）：${seen || '無'}。`,
        context.note ? context.note : null,
        `成員：${members.map((m) => m.name).join(', ')}。已依脈絡回覆，並標註出處。`,
      ].filter(Boolean);
      return {
        text: lines.join('\n'),
        to: [trigger.fromId || who].filter(Boolean), // 預設回覆觸發者；runtime 會補成 agentId
        replyTo: trigger.id,
        relates: [...usedIds, ...relatedIds],
      };
    },
  };
}
