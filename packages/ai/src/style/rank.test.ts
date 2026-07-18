import { describe, it, expect } from "vitest";
import { rankEpisodes, scoreEpisode } from "./rank.js";
import type { DialogueEpisode } from "./types.js";

function ep(turns: Array<["owner" | "client", string]>, index = 0): DialogueEpisode {
  return {
    chatLabel: "чат",
    episodeIndex: index,
    turns: turns.map(([role, text]) => ({ role, text }))
  };
}

describe("scoreEpisode", () => {
  it("монолог без второй стороны — 0", () => {
    expect(scoreEpisode(ep([["owner", "привет"], ["owner", "ещё"]]))).toBe(0);
    expect(scoreEpisode(ep([["client", "?"], ["client", "??"]]))).toBe(0);
  });

  it("содержательный диалог с исходом ценится выше короткого", () => {
    const rich = ep([
      ["client", "Здравствуйте, сколько стоит стрижка?"],
      ["owner", "5000 с укладкой, когда вам удобно записаться?"],
      ["client", "завтра днём"],
      ["owner", "Записал на 14:00, ждём вас, адрес отправлю"]
    ]);
    const poor = ep([
      ["client", "привет"],
      ["owner", "да"]
    ]);
    expect(scoreEpisode(rich)).toBeGreaterThan(scoreEpisode(poor));
  });
});

describe("rankEpisodes", () => {
  it("отсеивает короткие/мусорные и сортирует по убыванию", () => {
    const episodes = [
      ep([["client", "спасибо"]], 0), // 1 реплика — отсев
      ep(
        [
          ["client", "Здравствуйте, хочу записаться на маникюр"],
          ["owner", "Конечно, на какой день?"],
          ["client", "на пятницу"],
          ["owner", "Записала на пятницу, во сколько удобно?"]
        ],
        1
      ),
      ep([["owner", "реклама"], ["owner", "акция"], ["owner", "скидка"], ["owner", "успей"]], 2) // монолог
    ];
    const ranked = rankEpisodes(episodes, { minTurns: 2 });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.episode.episodeIndex).toBe(1);
  });

  it("ограничивает выборку limit'ом", () => {
    const many: DialogueEpisode[] = Array.from({ length: 10 }, (_, i) =>
      ep(
        [
          ["client", "вопрос про цену и запись подробно"],
          ["owner", "отвечаю по цене и предлагаю записаться"],
          ["client", "хорошо давайте"],
          ["owner", "оформил заявку, спасибо"]
        ],
        i
      )
    );
    const ranked = rankEpisodes(many, { limit: 3 });
    expect(ranked).toHaveLength(3);
  });
});
