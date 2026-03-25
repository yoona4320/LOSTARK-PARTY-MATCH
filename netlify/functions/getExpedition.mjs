// netlify/functions/getExpedition.mjs
// 전정실 HTML 스크래핑으로 전투력 실값 수집

const SUP = new Set(["바드", "홀리나이트", "도화가", "발키리"]);

function parseCombatPower(html) {
  const patterns = [
    /전투력\s*\n\s*([\d,]+\.?\d*)/m,
    /전투력<\/dt>\s*<dd[^>]*>\s*([\d,]+\.?\d*)/,
    /전투력[\s\S]{0,50}?([\d]{4,}[,\d]*\.?\d*)/,
    /"combatScore"\s*:\s*"?([\d,]+\.?\d*)"?/,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) {
      const val = Math.round(parseFloat(m[1].replace(/,/g, "")) || 0);
      if (val > 100) return val;
    }
  }
  return 0;
}

function parseItemLevel(html) {
  const patterns = [
    /장착 아이템 레벨\s*Lv\.([\d,]+\.?\d*)/,
    /아이템 레벨[\s\S]{0,20}?([\d,]+\.\d+)/,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) {
      const val = parseFloat(m[1].replace(/,/g, "")) || 0;
      if (val > 100) return val;
    }
  }
  return 0;
}

function parseCharLevel(html) {
  const patterns = [
    /전투 레벨\s*Lv\.(\d+)/,
    /전투 레벨Lv\.(\d+)/,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) {
      const val = parseInt(m[1]);
      if (val >= 1 && val <= 70) return val;
    }
  }
  return 0;
}

function parseClassName(html) {
  const patterns = [
    /<img[^>]*emblem_[^>]*alt="([^"]+)"[^>]*>/,
    /CharacterClassName['":\s]+"([^"]+)"/,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m && m[1].trim()) return m[1].trim();
  }
  return "";
}

async function fetchProfile(name) {
  const r = await fetch(
    `https://lostark.game.onstove.com/Profile/Character/${encodeURIComponent(name)}`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-cache",
      },
    }
  );
  if (!r.ok) throw new Error(`전정실 오류: ${r.status}`);
  return r.text();
}

export default async (request) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const url = new URL(request.url);
  const charName = url.searchParams.get("name");
  const apiKey = url.searchParams.get("key");
  const debug = url.searchParams.get("debug");

  if (!charName) {
    return new Response(JSON.stringify({ error: "name 파라미터 필요" }), { status: 400, headers });
  }

  // 디버그 모드: ?debug=1&name=캐릭터명 으로 호출하면 파싱 결과 확인 가능
  if (debug) {
    try {
      const html = await fetchProfile(charName);
      const idx = html.indexOf("전투력");
      const snippet = idx >= 0 ? html.slice(Math.max(0, idx - 30), idx + 150) : "전투력 텍스트 없음";
      return new Response(JSON.stringify({
        debug: true,
        charName,
        snippet,
        combatPower: parseCombatPower(html),
        level: parseCharLevel(html),
        itemLevel: parseItemLevel(html),
        className: parseClassName(html),
      }), { status: 200, headers });
    } catch (e) {
      return new Response(JSON.stringify({ debug: true, error: e.message }), { status: 200, headers });
    }
  }

  try {
    let siblings = [];

    if (apiKey) {
      try {
        const r = await fetch(
          `https://developer-lostark.game.onstove.com/characters/${encodeURIComponent(charName)}/siblings`,
          { headers: { accept: "application/json", authorization: `bearer ${apiKey}` } }
        );
        if (r.ok) {
          const data = await r.json();
          if (Array.isArray(data)) {
            siblings = data.map((c) => ({
              name: c.CharacterName,
              className: c.CharacterClassName || "",
              itemLevel: parseFloat((c.ItemAvgLevel || "0").replace(/,/g, "")) || 0,
            }));
          }
        }
      } catch (_) {}
    }

    if (!siblings.length) {
      const html = await fetchProfile(charName);
      const seen = new Set();
      const matches = [...html.matchAll(/Lv\.(\d+)\s*([^\n<()[\]]{2,20}?)(?=\s*\n|\s*<)/g)];
      for (const m of matches) {
        const nm = m[2].trim();
        if (parseInt(m[1]) >= 1 && nm.length >= 2 && !seen.has(nm)) {
          seen.add(nm);
          siblings.push({ name: nm, className: "", itemLevel: 0 });
        }
      }
    }

    siblings.sort((a, b) => b.itemLevel - a.itemLevel);
    const targets = siblings.slice(0, 20);

    const results = await Promise.allSettled(
      targets.map(async (c) => {
        try {
          const html = await fetchProfile(c.name);
          const combatPower = parseCombatPower(html);
          const itemLevel = parseItemLevel(html) || c.itemLevel;
          const level = parseCharLevel(html);
          const className = parseClassName(html) || c.className;
          const role = SUP.has(className) ? "support" : "dealer";
          return { name: c.name, level, itemLevel, combatPower, className, role };
        } catch (_) {
          return {
            name: c.name, level: 0, itemLevel: c.itemLevel,
            combatPower: 0, className: c.className,
            role: SUP.has(c.className) ? "support" : "dealer",
          };
        }
      })
    );

    const characters = results
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value)
      .sort((a, b) => b.itemLevel - a.itemLevel);

    return new Response(JSON.stringify({ characters }), { status: 200, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
  }
};

export const config = { path: "/api/getExpedition" };
