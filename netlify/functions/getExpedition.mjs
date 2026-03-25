// netlify/functions/getExpedition.mjs
const SUP = new Set(["바드", "홀리나이트", "도화가", "발키리"]);

function parseCombatPower(html) {
  // 실제 구조: <span>전투력</span><span>1,925<small>.02</small></span>
  const m = html.match(/<span>\s*전투력\s*<\/span>\s*<span>([\d,]+)<small>([\d.]*)<\/small><\/span>/);
  if (m) {
    const val = parseFloat(m[1].replace(/,/g, "") + m[2]) || 0;
    if (val > 0) return Math.round(val);
  }
  // 소수 없는 경우: <span>전투력</span><span>1,925</span>
  const m2 = html.match(/<span>\s*전투력\s*<\/span>\s*<span>([\d,]+)<\/span>/);
  if (m2) {
    const val = parseFloat(m2[1].replace(/,/g, "")) || 0;
    if (val > 0) return Math.round(val);
  }
  return 0;
}

function parseItemLevel(html) {
  // <span>장착 아이템 레벨</span><span>1,766<small>.67</small></span>
  const m = html.match(/<span>\s*장착 아이템 레벨\s*<\/span>\s*<span>([\d,]+)<small>([\d.]*)<\/small><\/span>/);
  if (m) return parseFloat(m[1].replace(/,/g, "") + m[2]) || 0;
  const m2 = html.match(/<span>\s*장착 아이템 레벨\s*<\/span>\s*<span>([\d,]+)<\/span>/);
  if (m2) return parseFloat(m2[1].replace(/,/g, "")) || 0;
  // 폴백
  const m3 = html.match(/장착 아이템 레벨\s*Lv\.([\d,]+\.?\d*)/);
  if (m3) return parseFloat(m3[1].replace(/,/g, "")) || 0;
  return 0;
}

function parseCharLevel(html) {
  // <span>전투 레벨</span><span>70</span>
  const m = html.match(/<span>\s*전투 레벨\s*<\/span>\s*<span>(\d+)<\/span>/);
  if (m) return parseInt(m[1]);
  const m2 = html.match(/전투 레벨\s*Lv\.(\d+)/);
  if (m2) return parseInt(m2[1]);
  return 0;
}

function parseClassName(html) {
  const m = html.match(/<img[^>]*emblem_[^>]*alt="([^"]+)"[^>]*>/);
  if (m && m[1].trim()) return m[1].trim();
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

  // 디버그 모드
  if (debug) {
    try {
      const html = await fetchProfile(charName);
      const idx = html.indexOf("전투력");
      const snippet = idx >= 0 ? html.slice(Math.max(0, idx - 30), idx + 200) : "전투력 텍스트 없음";
      return new Response(JSON.stringify({
        debug: true, charName, snippet,
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

    // 1) 공식 API로 원정대 캐릭터 목록
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

    // 2) API 키 없거나 실패 → 전정실에서 보유 캐릭 목록 파싱
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

    // 3) 각 캐릭터 전정실 → 전투력 실값 병렬 수집
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
