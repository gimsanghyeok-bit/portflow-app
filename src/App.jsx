import { useState, useRef, useCallback, useEffect } from "react";

// ══════════════════════════════════════════════════════
// 배포용: localStorage + /api/gemini 프록시 (Gemini 무료 API)
// ══════════════════════════════════════════════════════
const storage = {
  async get(key) {
    const v = localStorage.getItem(key);
    if (v === null) throw new Error("not found");
    return { key, value: v };
  },
  async set(key, value) { localStorage.setItem(key, value); return { key, value }; },
  async delete(key) { localStorage.removeItem(key); return { key, deleted: true }; },
};

// Claude 메시지 형식({role, content:[{type:"image"|"text",...}]})을
// Gemini 형식(contents:[{role, parts:[{inline_data|text}]}])으로 변환
function toGeminiContents(messages) {
  return messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: Array.isArray(m.content)
      ? m.content.map(c =>
          c.type === "image"
            ? { inline_data: { mime_type: c.source.media_type, data: c.source.data } }
            : { text: c.text }
        )
      : [{ text: m.content }],
  }));
}

// 이름은 callClaude로 유지 (호출부 5곳을 안 바꾸려고) — 내부는 Gemini 호출로 교체됨
async function callClaude({ system, messages, max_tokens = 1000, tools }) {
  const resp = await fetch("/api/gemini", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: toGeminiContents(messages),
      systemInstruction: system,
      maxOutputTokens: max_tokens,
      useSearch: !!tools, // 웹 검색 도구 요청 여부만 서버로 전달 (형식은 서버가 구성)
    }),
  });
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

// 검색 도구를 쓰면 응답이 여러 text 파트로 쪼개져 올 수 있음.
// 여러 조합(전체 이어붙임 / 마지막 파트 / 첫 파트)을 다 시도해서,
// 그중 "가장 내용이 많이 채워진" 결과를 채택 (일부 조각만 파싱되는 사고 방지)
function parseAIJson(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const blocks = parts.filter(p => typeof p.text === "string").map(p => p.text);
  if (blocks.length === 0) {
    const blockReason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason;
    throw new Error(blockReason ? `응답 없음 (${blockReason})` : "응답에 텍스트가 없습니다");
  }
  const candidates = [blocks.join("")];
  if (blocks.length > 1) { candidates.push(blocks[blocks.length - 1], blocks[0]); }

  let best = null, bestScore = -1;
  for (const cand of candidates) {
    const parsed = tryParseOne(cand);
    if (!parsed) continue;
    const score = JSON.stringify(parsed).length; // 더 길게(=더 많이) 파싱된 쪽을 채택
    if (score > bestScore) { best = parsed; bestScore = score; }
  }
  if (!best) throw new Error("JSON 파싱 실패 (응답이 잘렸거나 형식이 어긋남)");
  return best;
}
function tryParseOne(raw) {
  let s = raw.replace(/```json|```/g, "").trim();
  try { return JSON.parse(s); } catch (e) {}
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch (e) {}
  }
  const as = s.indexOf("[");
  const ae = s.lastIndexOf("]");
  if (as !== -1 && ae !== -1 && ae > as) {
    try { return JSON.parse(s.slice(as, ae + 1)); } catch (e) {}
  }
  return null;
}


const SECTOR_COLORS = ["#D97757","#5B7A99","#C98A2C","#BC4B3C","#5B8C5A","#6B8CAE","#A6748A","#8AA34A"];

const DEFAULT_TARGETS = [
  { name:"반도체",    targetPct:30, color:SECTOR_COLORS[0] },
  { name:"2차전지",   targetPct:20, color:SECTOR_COLORS[1] },
  { name:"바이오",    targetPct:15, color:SECTOR_COLORS[2] },
  { name:"금융",      targetPct:15, color:SECTOR_COLORS[3] },
  { name:"IT/플랫폼", targetPct:10, color:SECTOR_COLORS[4] },
  { name:"현금",      targetPct:10, color:SECTOR_COLORS[5] },
];

const STORAGE_KEY = "portflow:state:v2";

const uid = () => Math.random().toString(36).slice(2, 9);
const fmtKRW = (n) => {
  const a = Math.abs(n);
  return a >= 1e8 ? `${(n/1e8).toFixed(2)}억` : a >= 1e4 ? `${Math.round(n/1e4).toLocaleString()}만` : Math.round(n).toLocaleString();
};
const delay = (ms) => new Promise(r => setTimeout(r, ms));
const timeAgo = (iso) => {
  if (!iso) return null;
  const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (diffMin < 1) return "방금 전";
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전`;
  return `${Math.round(diffHr / 24)}일 전`;
};

// ── 핵심 계산: 수익률 게이팅 리밸런싱 ─────────────────
function calcRebalancing(holdings, targets, fx, opts) {
  const { driftTol, profitOnly, minProfitPct, sellOffset, buyOffset } = opts;
  const toKRW = (h) => (h.currency === "USD" ? h.evalAmt * fx : h.evalAmt);
  const pxKRW = (h) => (h.currency === "USD" ? h.price * fx : h.price);
  const avgKRW = (h) => (h.currency === "USD" ? (h.avgPrice || 0) * fx : (h.avgPrice || 0));
  const total = holdings.reduce((s, h) => s + toKRW(h), 0);

  return targets.map(t => {
    const sec = holdings.filter(h => h.sector === t.name);
    const cur = sec.reduce((s, h) => s + toKRW(h), 0);
    const curPct = total > 0 ? (cur / total) * 100 : 0;
    const diff = total * (t.targetPct / 100) - cur;
    const drift = curPct - t.targetPct;

    const trades = sec.map(h => {
      const hKRW = toKRW(h), p = pxKRW(h), a = avgKRW(h);
      const share = cur > 0 ? hKRW / cur : 1 / Math.max(sec.length, 1);
      const hDiff = diff * share;
      const profitPct = a > 0 ? ((p - a) / a) * 100 : null;
      const qty = p > 0 ? Math.floor(Math.abs(hDiff) / p) : 0;
      let action = qty === 0 ? "HOLD" : hDiff > 0 ? "BUY" : "SELL";

      // 수익 실현 게이팅: 손실 중이거나 목표 수익률 미달이면 매도 보류
      let held = false;
      if (action === "SELL" && profitOnly && profitPct !== null && profitPct < minProfitPct) {
        held = true; action = "WAIT";
      }
      const realized = action === "SELL" && a > 0 ? (p - a) * qty : 0;
      const limitPrice = action === "SELL" ? p * (1 + sellOffset / 100)
                       : action === "BUY"  ? p * (1 - buyOffset / 100) : p;
      // 목표 수익률 도달에 필요한 주가
      const breakEvenTarget = a > 0 ? a * (1 + minProfitPct / 100) : null;

      return { holding: h, action, held, quantity: qty, amtKRW: qty * p,
               profitPct, realized, limitPrice, breakEvenTarget, priceKRW: p, avgKRWv: a };
    });

    const heldCount = trades.filter(t2 => t2.held).length;
    const actionable = trades.filter(t2 => t2.action === "BUY" || t2.action === "SELL");
    return { ...t, currentAmtKRW: cur, currentPct: curPct, diff, drift,
             needsAction: Math.abs(drift) > driftTol, trades, heldCount, actionable };
  });
}

function Donut({ slices, size = 170 }) {
  const r = size * 0.32, cx = size / 2, cy = size / 2, circ = 2 * Math.PI * r;
  let off = 0;
  return (
    <svg width={size} height={size} style={{ overflow: "visible" }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#E4DDCC" strokeWidth={size*0.13} />
      {slices.map((s, i) => {
        const dash = (s.pct / 100) * circ;
        const el = <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={s.color} strokeWidth={size*0.13}
          strokeDasharray={`${dash} ${circ - dash}`} strokeDashoffset={-off}
          style={{ transform:"rotate(-90deg)", transformOrigin:"50% 50%", transition:"stroke-dasharray .6s" }} />;
        off += dash; return el;
      })}
    </svg>
  );
}

export default function App() {
  const [tab, setTab] = useState("home");
  const [holdings, setHoldings] = useState([]);
  const [targets, setTargets] = useState(DEFAULT_TARGETS);
  const [fx, setFx] = useState(1340);
  const [driftTol, setDriftTol] = useState(5);

  // 수익 실현 규칙
  const [profitOnly, setProfitOnly] = useState(true);
  const [minProfitPct, setMinProfitPct] = useState(5);
  const [sellOffset, setSellOffset] = useState(1);
  const [buyOffset, setBuyOffset] = useState(1);

  const [storageReady, setStorageReady] = useState(false);
  const [saveStatus, setSaveStatus] = useState("idle");
  const [lastSaved, setLastSaved] = useState(null);
  const saveTimer = useRef(null);

  const [imgSrc, setImgSrc] = useState(null);
  const [ocrStatus, setOcrStatus] = useState("idle");
  const [ocrStep, setOcrStep] = useState(0);
  const [parsed, setParsed] = useState([]);
  const fileRef = useRef(null);

  const [newsText, setNewsText] = useState("");
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsResult, setNewsResult] = useState(null);
  const [newsSource, setNewsSource] = useState(null); // "auto" | null
  const [expanded, setExpanded] = useState(null);

  // 갈아타기 제안
  const [switchLoading, setSwitchLoading] = useState(false);
  const [switchResult, setSwitchResult] = useState(null);
  const [lastSwitchAt, setLastSwitchAt] = useState(null);

  // 신규 종목 발굴
  const [discMarket, setDiscMarket] = useState("domestic"); // domestic | overseas
  const [discStyle, setDiscStyle] = useState("");
  const [discLoading, setDiscLoading] = useState(false);
  const [discResult, setDiscResult] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await storage.get(STORAGE_KEY);
        const s = JSON.parse(r.value);
        if (s.holdings) setHoldings(s.holdings);
        if (s.targets?.length) setTargets(s.targets);
        if (s.fx) setFx(s.fx);
        if (s.driftTol) setDriftTol(s.driftTol);
        if (typeof s.profitOnly === "boolean") setProfitOnly(s.profitOnly);
        if (s.minProfitPct != null) setMinProfitPct(s.minProfitPct);
        if (s.sellOffset != null) setSellOffset(s.sellOffset);
        if (s.buyOffset != null) setBuyOffset(s.buyOffset);
        if (s.lastSwitchAt) setLastSwitchAt(s.lastSwitchAt);
        if (s.savedAt) setLastSaved(new Date(s.savedAt));
      } catch (e) { /* 첫 실행 */ }
      setStorageReady(true);
    })();
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaveStatus("saving");
    saveTimer.current = setTimeout(async () => {
      try {
        const savedAt = new Date().toISOString();
        await storage.set(STORAGE_KEY, JSON.stringify({
          holdings, targets, fx, driftTol, profitOnly, minProfitPct, sellOffset, buyOffset, lastSwitchAt, savedAt }));
        setSaveStatus("saved"); setLastSaved(new Date(savedAt));
        setTimeout(() => setSaveStatus("idle"), 2000);
      } catch (e) { setSaveStatus("error"); }
    }, 1000);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [holdings, targets, fx, driftTol, profitOnly, minProfitPct, sellOffset, buyOffset, lastSwitchAt, storageReady]);

  const resetAll = async () => {
    if (!confirm("저장된 모든 데이터를 삭제할까요?")) return;
    try { await storage.delete(STORAGE_KEY); } catch (e) {}
    setHoldings([]); setTargets(DEFAULT_TARGETS); setFx(1340); setDriftTol(5);
    setProfitOnly(true); setMinProfitPct(5); setLastSaved(null);
  };

  const opts = { driftTol, profitOnly, minProfitPct, sellOffset, buyOffset };
  // 목표 비중에 없는 섹터(예: 종목 추가 시 새 섹터를 만들었는데 목표 비중엔 등록 안 한 경우)가
  // 계산에서 통째로 누락되지 않도록, 목표 0%인 "미분류" 섹터로 자동 포함시킴
  const targetNames = new Set(targets.map(t => t.name));
  const unclassifiedNames = [...new Set(holdings.map(h => h.sector).filter(Boolean))]
    .filter(name => !targetNames.has(name));
  const effectiveTargets = unclassifiedNames.length > 0
    ? [...targets, ...unclassifiedNames.map(name => ({ name, targetPct: 0, color: "#9C8F78", unclassified: true }))]
    : targets;
  const sectorResults = calcRebalancing(holdings, effectiveTargets, fx, opts);
  const toKRW = (h) => (h.currency === "USD" ? h.evalAmt * fx : h.evalAmt);
  const totalKRW = holdings.reduce((s, h) => s + toKRW(h), 0);
  const unclassifiedKRW = unclassifiedNames.reduce((sum, name) => {
    const sec = sectorResults.find(s => s.name === name);
    return sum + (sec?.currentAmtKRW || 0);
  }, 0);
  const totalCost = holdings.reduce((s,h) => {
    const a = h.currency === "USD" ? (h.avgPrice||0)*fx : (h.avgPrice||0);
    return s + a * (h.quantity||0);
  }, 0);
  const totalPnL = totalCost > 0 ? totalKRW - totalCost : 0;
  const totalPnLPct = totalCost > 0 ? (totalPnL / totalCost) * 100 : 0;
  const alertCount = sectorResults.filter(s => s.needsAction).length;
  const heldTotal = sectorResults.reduce((s,x)=>s+x.heldCount,0);
  const targetSum = targets.reduce((s, t) => s + t.targetPct, 0);
  const sentColor = { bullish:"#5B8C5A", neutral:"#C98A2C", bearish:"#BC4B3C" };

  const allSells = sectorResults.flatMap(s=>s.trades).filter(t=>t.action==="SELL");
  const totalRealize = allSells.reduce((s,t)=>s+t.realized,0);
  const sellProceeds = allSells.reduce((s,t)=>s+t.amtKRW,0);

  // ── OCR ──
  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setImgSrc(URL.createObjectURL(file));
    setOcrStatus("parsing");
    for (let i = 0; i < 4; i++) { setOcrStep(i); await delay(450); }
    try {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1]);
        r.onerror = rej; r.readAsDataURL(file);
      });
      const systemPrompt = `당신은 한국 증권사(키움/미래에셋/삼성증권/NH/토스 등) 잔고 화면 전용 OCR 파싱 엔진입니다.
이미지에서 보유 종목을 추출해 순수 JSON 배열만 반환하세요. 마크다운/설명 없이.
필드: ticker(종목코드 6자리, 없으면 ""), name(종목명), quantity(보유수량 숫자), price(현재가 숫자), avgPrice(매입평균가/평단 숫자), evalAmt(평가금액 숫자), currency("KRW"), sector
★ avgPrice(매입가·평균단가·매입평균가)는 반드시 찾아서 넣으세요. 화면에 없고 "매입금액"만 있으면 매입금액÷수량으로 계산하세요. 정말 없으면 0.
섹터 분류: 삼성전자,SK하이닉스,한미반도체,DB하이텍,리노공업→"반도체" / LG에너지솔루션,삼성SDI,에코프로비엠,포스코퓨처엠,엘앤에프→"2차전지" / 셀트리온,삼성바이오로직스,유한양행,알테오젠→"바이오" / KB금융,신한지주,하나금융지주,삼성생명,메리츠금융지주→"금융" / NAVER,카카오,크래프톤,엔씨소프트→"IT/플랫폼" / 나머지→"기타"
숫자에서 ₩ , 원 % 제거. JSON 배열만.`;
      const data = await callClaude({
        system: systemPrompt, max_tokens: 1800,
        messages: [{ role:"user", content: [
          { type:"image", source:{ type:"base64", media_type:file.type||"image/jpeg", data:b64 } },
          { type:"text", text:"이 잔고 화면의 모든 종목을 매입평균가 포함해 JSON 배열로 추출하세요." }
        ]}]
      });
      const arr = parseAIJson(data);
      setParsed(arr.map(h => {
        const calc = (h.quantity||0) * (h.price||0);
        const ok = h.evalAmt > 0 ? Math.abs(calc - h.evalAmt) / h.evalAmt < 0.15 : false;
        return { ...h, currency: h.currency || "KRW", avgPrice: h.avgPrice || 0,
                 id: uid(), sanityOk: ok };
      }));
    } catch (e) { setParsed([]); }
    setOcrStatus("done");
  }, []);

  // ── 시황 분석 (직접 입력) ──
  const analyzeNews = async () => {
    if (!newsText.trim()) return;
    setNewsLoading(true); setNewsResult(null); setNewsSource(null);
    try {
      const systemPrompt = `당신은 한국 주식시장(코스피/코스닥) 전문 포트폴리오 매니저 AI입니다.
★ 절대 규칙: ① 추천은 코스피200 구성 또는 시총 상위 우량주만 ② 소형주·테마주·작전주·급등주 배제 ③ 투기적 표현 금지 ④ 종목명은 한국거래소 정식 명칭 ⑤ 단정적 예측 금지, 근거 중심 서술
JSON만 반환 (마크다운 없이):
{"summary":"3문장 요약","macro":"거시경제 영향","sentiment":"bullish|neutral|bearish","leaders":[{"theme":"","reason":""}],"sectorImpact":[{"sector":"","impact":"positive|negative|neutral","reason":""}],"bluechipRecs":[{"ticker":"","name":"","reason":"","category":"대형주|우량주|배당성장주","marketCap":""}],"risks":["",""],"portfolioAction":""}`;
      const data = await callClaude({ system: systemPrompt, max_tokens: 1800,
        messages: [{ role:"user", content: newsText }] });
      setNewsResult(parseAIJson(data));
    } catch (e) { setNewsResult(null); }
    setNewsLoading(false);
  };

  // ── 오늘 시황 자동 분석 (웹 검색 도구 사용) ──
  const autoFetchNews = async () => {
    setNewsLoading(true); setNewsResult(null); setNewsSource(null);
    try {
      const today = new Date().toLocaleDateString("ko-KR", { year:"numeric", month:"long", day:"numeric" });
      const systemPrompt = `당신은 한국 주식시장(코스피/코스닥) 전문 포트폴리오 매니저 AI입니다. 웹 검색 도구로 오늘(${today}) 한국 증시 관련 최신 뉴스를 직접 찾아서 분석하세요.
★ 검색 지침: 검색은 2~3회 이내로 효율적으로 (코스피 마감 동향 1회, 주요 섹터/한국은행 이슈 1~2회). 검색 결과를 다 읽고 정리할 시간을 남겨두세요.
★ 절대 규칙: ① 추천은 코스피200 구성 또는 시총 상위 우량주만 ② 소형주·테마주·작전주·급등주 배제 ③ 투기적 표현 금지 ④ 종목명은 한국거래소 정식 명칭 ⑤ 단정적 예측 금지, 근거 중심 서술 ⑥ 검색으로 찾은 실제 뉴스에 기반해서만 작성 (추측 금지) ⑦★★ 절대로 빈 문자열("")이나 빈 배열([])로 응답하지 마세요. 모든 필드를 검색으로 찾은 실제 내용으로 채우세요. 못 채우겠으면 그 필드는 최선을 다해 일반적인 시황이라도 채워 넣으세요.
검색과 분석이 끝나면, 검색 과정이나 찾은 내용에 대한 설명 문장을 절대 먼저 쓰지 말고, 최종 응답의 맨 처음부터 바로 아래 JSON 객체 하나만 반환하세요. JSON 앞뒤에 어떠한 텍스트/설명/마크다운도 붙이지 마세요:
{"summary":"오늘 시황 3문장 요약(반드시 채울 것)","macro":"거시경제 영향 (반드시 채울 것)","sentiment":"bullish|neutral|bearish","leaders":[{"theme":"주도 테마명","reason":"이유"}],"sectorImpact":[{"sector":"섹터명","impact":"positive|negative|neutral","reason":"이유"}],"bluechipRecs":[{"ticker":"","name":"","reason":"","category":"대형주|우량주|배당성장주","marketCap":""}],"risks":["리스크1","리스크2"],"portfolioAction":"대응 전략 (반드시 채울 것)"}`;
      const data = await callClaude({
        system: systemPrompt, max_tokens: 4000,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role:"user", content: "오늘 한국 증시 시황을 검색해서 위 형식에 맞게, 모든 필드를 실제 내용으로 채워서 분석해주세요." }],
      });
      const parsed = parseAIJson(data);
      const isEmpty = !parsed.summary?.trim() && !parsed.macro?.trim() && (!parsed.sectorImpact || parsed.sectorImpact.length === 0);
      if (isEmpty) throw new Error("검색은 됐지만 응답 내용이 비어 있습니다. 다시 시도해주세요.");
      setNewsResult(parsed);
      setNewsSource("auto");
      setNewsText("");
    } catch (e) { setNewsResult(null); alert(e.message || "자동 분석에 실패했습니다. 다시 시도해주세요."); }
    setNewsLoading(false);
  };

  // ── 갈아타기 제안 (포트폴리오 컨텍스트 포함) ──
  const suggestSwitch = async () => {
    if (holdings.length === 0) { alert("먼저 보유 종목을 등록해주세요."); return; }
    setSwitchLoading(true); setSwitchResult(null);
    try {
      const today = new Date().toLocaleDateString("ko-KR", { year:"numeric", month:"long", day:"numeric" });
      const ctx = {
        오늘날짜: today,
        총자산_원: Math.round(totalKRW),
        총수익률_퍼센트: +totalPnLPct.toFixed(1),
        목표비중: targets.map(t=>({섹터:t.name, 목표:t.targetPct})),
        현재비중: sectorResults.map(s=>({섹터:s.name, 현재:+s.currentPct.toFixed(1), 괴리:+s.drift.toFixed(1)})),
        보유종목: holdings.map(h=>{
          const p = h.currency==="USD"?h.price*fx:h.price;
          const a = h.currency==="USD"?(h.avgPrice||0)*fx:(h.avgPrice||0);
          return { 종목:h.name, 코드:h.ticker, 섹터:h.sector, 수량:h.quantity,
                   현재가:Math.round(p), 매수단가:Math.round(a),
                   수익률: a>0 ? +(((p-a)/a)*100).toFixed(1) : null };
        }),
        현재_매도규칙: profitOnly ? `수익률 ${minProfitPct}% 이상인 종목만 매도` : "수익률 무관 매도 허용",
      };
      const systemPrompt = `당신은 한국 주식 포트폴리오 리밸런싱 전문 AI입니다. 웹 검색으로 오늘(${today})의 실제 시황(코스피/코스닥 동향, 주도 섹터/주도주, 국제 정세·환율 등 국내 증시에 영향 주는 요인)을 먼저 파악한 뒤, 사용자의 실제 포트폴리오와 결합해 리밸런싱을 제안합니다.
★ 검색 지침: 검색은 2~3회 이내로 효율적으로 (오늘 증시 동향 1회, 보유 섹터 관련 이슈 1~2회).
★ 절대 규칙:
① "현재_매도규칙"을 기본 기준으로 삼되, 오늘 시황(주도주 여부, 섹터 모멘텀, 리스크 요인)에 따라 이 기준을 조정하는 게 낫다고 판단되면 suggestedRule에 근거와 함께 제안할 것. 사용자가 직접 적용 여부를 결정하므로, 판단 근거를 명확히 설명할 것.
② 매도 대상은 원칙적으로 "현재_매도규칙"의 수익률 기준을 만족하는 종목 중에서 고르되, 시황상 특별히 매도를 권장/보류할 이유가 있으면 reason에 명시. 기준 미달 종목은 hold로.
③ 추천 매수 종목은 코스피200 구성 또는 시총 상위 우량주만. 소형주·테마주·작전주 배제. 오늘 시황에서 확인된 주도 섹터/주도주를 우선 고려.
④ 매도/매수 희망가는 "현재가 대비 합리적 범위"로 제시, 예측이 아닌 참고 구간임을 reason에 명시.
⑤ 매도 대금 총액 범위 안에서만 매수 수량을 제안 (자금 초과 금지).
⑥ 단정적 수익 보장 표현 금지. 검색으로 확인된 실제 내용에 근거해서만 작성.
⑦★ 검색 과정 설명 없이, 최종 응답은 아래 JSON 객체 하나만 반환. 앞뒤에 텍스트/마크다운 금지. 빈 문자열이나 빈 배열로 응답하지 말 것 — 모든 필드를 실제 내용으로 채울 것:
{"marketSummary":"오늘 시황 2~3문장 요약 (주도주/주도섹터 포함)","diagnosis":"내 포트폴리오 진단 2~3문장","suggestedRule":{"changed":true,"minProfitPct":0,"reason":"기준 조정 제안 근거 (조정 불필요하면 changed:false, reason에 이유)"},"sells":[{"name":"","ticker":"","quantity":0,"limitPrice":0,"profitPct":0,"reason":""}],"holds":[{"name":"","reason":""}],"buys":[{"name":"","ticker":"","sector":"","quantity":0,"limitPrice":0,"amountKRW":0,"reason":""}],"cashLeft":0,"caution":"주의사항"}`;
      const data = await callClaude({
        system: systemPrompt, max_tokens: 4500,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role:"user", content: `오늘 시황을 검색해서 반영한 뒤, 내 포트폴리오에 맞는 리밸런싱을 제안해주세요.\n${JSON.stringify(ctx, null, 1)}` }],
      });
      const parsed = parseAIJson(data);
      const isEmpty = !parsed.diagnosis?.trim() && !parsed.marketSummary?.trim() && (!parsed.sells?.length && !parsed.buys?.length && !parsed.holds?.length);
      if (isEmpty) throw new Error("검색은 됐지만 응답 내용이 비어 있습니다. 다시 시도해주세요.");
      setSwitchResult(parsed);
      setLastSwitchAt(new Date().toISOString());
    } catch (e) { setSwitchResult({ error: true, msg: e.message }); }
    setSwitchLoading(false);
  };

  // ── 신규 종목 발굴 (국내/해외, 포트폴리오 무관) ──
  const discoverStocks = async () => {
    setDiscLoading(true); setDiscResult(null);
    try {
      const sectorNames = targets.map(t=>t.name).join(", ");
      const isDomestic = discMarket === "domestic";
      const systemPrompt = isDomestic
        ? `당신은 한국 주식시장(코스피/코스닥) 종목 발굴 전문 AI입니다.
★ 절대 규칙: ① 코스피200 구성 또는 시총 상위 우량주 중심 (신규 상장·소형주·테마주·작전주 배제) ② 종목명은 한국거래소 정식 명칭, 종목코드 포함 ③ 투기적/단정적 표현 금지, 근거 중심 ④ 사용자가 스타일을 지정하면 그 기준에 맞춰 고를 것 (예: 배당주면 배당수익률·배당성향 근거 제시) ⑤ reason은 2문장 이내로 간결하게
JSON만 반환 (마크다운 없이):
{"picks":[{"ticker":"","name":"","sector":"","style":"","reason":"","marketCap":"","note":""}],"caution":"주의사항"}`
        : `당신은 미국/글로벌 주식시장 종목 발굴 전문 AI입니다.
★ 절대 규칙: ① S&P500 또는 나스닥100 등 대형 우량주 중심 (소형주·밈주식·최근 상장주 배제) ② 티커와 정식 회사명 포함 ③ 투기적/단정적 표현 금지, 근거 중심 ④ 사용자가 스타일을 지정하면 그 기준에 맞춰 고를 것 ⑤ reason은 2문장 이내로 간결하게
JSON만 반환 (마크다운 없이):
{"picks":[{"ticker":"","name":"","sector":"","style":"","reason":"","marketCap":"","note":""}],"caution":"주의사항"}`;
      const userMsg = discStyle.trim()
        ? `다음 조건에 맞는 신규 투자 후보 5~6개를 추천해주세요: ${discStyle}\n(현재 보유 섹터: ${sectorNames || "없음"} — 겹치지 않는 새로운 아이디어도 환영)`
        : `현재 보유 섹터(${sectorNames || "없음"})와 겹치지 않는, 우량주 위주 신규 투자 후보 5~6개를 다양한 스타일(성장/배당/저평가 등 섞어서)로 추천해주세요.`;
      const data = await callClaude({ system: systemPrompt, max_tokens: 2200,
        messages: [{ role:"user", content: userMsg }] });
      setDiscResult(parseAIJson(data));
    } catch (e) { setDiscResult({ error: true, msg: e.message }); }
    setDiscLoading(false);
  };

  // ── 보유 종목 편집 ──
  const updH = (id, patch) => setHoldings(prev => prev.map(h => {
    if (h.id !== id) return h;
    const n = { ...h, ...patch };
    n.evalAmt = (n.quantity || 0) * (n.price || 0);
    return n;
  }));
  const addH = () => setHoldings(prev => [...prev, { id:uid(), ticker:"", name:"새 종목",
    quantity:0, price:0, avgPrice:0, evalAmt:0, currency:"KRW", sector:targets[0]?.name||"기타", sanityOk:true }]);

  if (!storageReady) {
    return (
      <div style={{...S.app, alignItems:"center", justifyContent:"center"}}>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}} .spin{width:34px;height:34px;border:3px solid #E4DDCC;border-top:3px solid #D97757;border-radius:50%;animation:spin .8s linear infinite}`}</style>
        <div className="spin"/><div style={{marginTop:16,fontSize:12,color:"#9C8F78"}}>불러오는 중...</div>
      </div>
    );
  }

  return (
    <div style={S.app}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
        ::-webkit-scrollbar{display:none}
        input,textarea,select{outline:none}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
        @keyframes spin{to{transform:rotate(360deg)}}
        .fade{animation:fadeUp .35s ease both}
        .spin{width:34px;height:34px;border:3px solid #E4DDCC;border-top:3px solid #D97757;border-radius:50%;animation:spin .8s linear infinite}
      `}</style>

      <header style={S.topbar}>
        <span style={S.logo}>PORTFLOW<span style={{color:"#D97757"}}>·AI</span></span>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:9,letterSpacing:1,fontWeight:700,transition:"color .3s",
            color: saveStatus==="saved"?"#5B8C5A":saveStatus==="saving"?"#C98A2C":saveStatus==="error"?"#BC4B3C":"#9C8F78"}}>
            {saveStatus==="saving"?"● 저장 중":saveStatus==="saved"?"✓ 저장됨":saveStatus==="error"?"⚠ 실패":lastSaved?"☁ 동기화됨":""}
          </span>
        </div>
      </header>

      <main style={S.main}>

        {/* ════ 홈 ════ */}
        {tab === "home" && (
          <div className="fade">
            <div style={{padding:"8px 0 18px"}}>
              <div style={S.heroLabel}>총 평가 자산</div>
              <div style={S.heroValue}>₩{fmtKRW(totalKRW)}</div>
              {totalCost > 0 && (
                <div style={{display:"flex",alignItems:"baseline",gap:8,marginBottom:10}}>
                  <span style={{fontSize:15,fontWeight:800,color:totalPnL>=0?"#5B8C5A":"#BC4B3C"}}>
                    {totalPnL>=0?"▲":"▼"} ₩{fmtKRW(Math.abs(totalPnL))}
                  </span>
                  <span style={{fontSize:13,fontWeight:700,color:totalPnL>=0?"#5B8C5A":"#BC4B3C"}}>
                    ({totalPnLPct>=0?"+":""}{totalPnLPct.toFixed(2)}%)
                  </span>
                  <span style={{fontSize:10,color:"#9C8F78"}}>매입 ₩{fmtKRW(totalCost)}</span>
                </div>
              )}
              <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                <span style={badge("#D97757")}>{holdings.length}개 종목</span>
                {alertCount > 0 && <span style={badge("#BC4B3C")}>⚡ {alertCount}개 섹터 이탈</span>}
                {heldTotal > 0 && <span style={badge("#C98A2C")}>⏸ {heldTotal}개 매도 보류</span>}
              </div>
            </div>

            {unclassifiedNames.length > 0 && (
              <div style={{...S.card, borderColor:"#C98A2C40", background:"#C98A2C08"}}>
                <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                  <span style={{fontSize:18,flexShrink:0}}>⚠️</span>
                  <div style={{flex:1}}>
                    <div style={{fontSize:12,fontWeight:700,color:"#C98A2C",marginBottom:4}}>
                      목표 비중에 없는 섹터 {unclassifiedNames.length}개 (₩{fmtKRW(unclassifiedKRW)})
                    </div>
                    <div style={{fontSize:11,color:"#7A6F5E",lineHeight:1.8,marginBottom:10}}>
                      <b>{unclassifiedNames.join(", ")}</b> 종목이 목표 비중 설정에 없어서, 도넛 차트·리밸런싱 계산에서 빠져 있어요. 목표 비중에 추가해주세요.
                    </div>
                    <button onClick={()=>{
                      setTargets(prev=>[...prev, ...unclassifiedNames.map((name,i)=>({ name, targetPct:0, color: SECTOR_COLORS[(prev.length+i)%SECTOR_COLORS.length] }))]);
                      setTab("rebalance");
                    }} style={{background:"#C98A2C", color:"#FFFFFF", border:"none", borderRadius:99, padding:"7px 14px", fontFamily:"inherit", fontSize:11, fontWeight:700, cursor:"pointer"}}>
                      목표 비중에 추가하기 (0%로)
                    </button>
                  </div>
                </div>
              </div>
            )}

            {holdings.length === 0 ? (
              <div style={{...S.card, textAlign:"center", padding:"36px 20px"}}>
                <div style={{fontSize:34,marginBottom:10}}>📷</div>
                <div style={{fontSize:14,fontWeight:700,marginBottom:6}}>보유 종목이 없습니다</div>
                <div style={{fontSize:11,color:"#7A6F5E",lineHeight:1.8,marginBottom:16}}>
                  증권사 잔고 화면을 캡처해서 올리면<br/>매입단가까지 자동으로 읽어옵니다
                </div>
                <button style={{...S.btnPrimary, width:"100%"}} onClick={()=>setTab("upload")}>잔고 캡처 올리기 →</button>
              </div>
            ) : (
              <>
                <div style={S.hscroll}>
                  {[
                    { l:"평가손익", v:`${totalPnL>=0?"+":""}${fmtKRW(totalPnL)}`, c: totalPnL>=0?"#5B8C5A":"#BC4B3C" },
                    { l:"수익률", v:`${totalPnLPct>=0?"+":""}${totalPnLPct.toFixed(1)}%`, c: totalPnL>=0?"#5B8C5A":"#BC4B3C" },
                    { l:"섹터", v:`${targets.length}개`, c:"#D97757" },
                    { l:"조치필요", v:`${alertCount}건`, c: alertCount>0?"#BC4B3C":"#5B8C5A" },
                  ].map((k,i)=>(
                    <div key={i} style={{...S.kpiCard, borderColor:`${k.c}40`}}>
                      <div style={S.kpiLabel}>{k.l}</div>
                      <div style={{...S.kpiValue, color:k.c}}>{k.v}</div>
                    </div>
                  ))}
                </div>

                <div style={S.card}>
                  <div style={S.sectionLabel}>섹터 비중</div>
                  <div style={{display:"flex",alignItems:"center",gap:18,flexWrap:"wrap",justifyContent:"center"}}>
                    <div style={{position:"relative",display:"inline-block"}}>
                      <Donut slices={sectorResults.map(s=>({pct:s.currentPct,color:s.color}))} />
                      <div style={S.donutCenter}>
                        <div style={{fontSize:9,letterSpacing:3,textTransform:"uppercase",color:"#9C8F78"}}>현재</div>
                        <div style={{fontSize:13,fontWeight:700,color:"#D97757",marginTop:2}}>₩{fmtKRW(totalKRW)}</div>
                      </div>
                    </div>
                    <div style={{flex:1,minWidth:150,display:"flex",flexDirection:"column",gap:7}}>
                      {sectorResults.map((s,i)=>(
                        <div key={i} style={{display:"flex",alignItems:"center",gap:6}}>
                          <div style={{width:8,height:8,borderRadius:2,background:s.color,flexShrink:0}}/>
                          <span style={{flex:1,fontSize:11,color:"#7A6F5E",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.name}</span>
                          <span style={{fontSize:11,fontWeight:700,color:s.color}}>{s.currentPct.toFixed(1)}%</span>
                          <span style={{fontSize:10,color:"#9C8F78"}}>→ {s.targetPct}%</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {alertCount > 0 && (
                  <button style={S.ctaBanner} onClick={()=>setTab("rebalance")}>
                    <div style={{textAlign:"left"}}>
                      <div style={{fontSize:14,fontWeight:700,color:"#BC4B3C",marginBottom:3}}>⚡ 리밸런싱 필요</div>
                      <div style={{fontSize:11,color:"#7A6F5E"}}>{alertCount}개 섹터가 목표 비중을 이탈했습니다</div>
                    </div>
                    <span style={{fontSize:22,color:"#BC4B3C"}}>→</span>
                  </button>
                )}
              </>
            )}

            <button onClick={resetAll} style={S.ghostBtn}>🗑 저장 데이터 초기화</button>
          </div>
        )}

        {/* ════ 업로드 ════ */}
        {tab === "upload" && (
          <div className="fade">
            <div style={S.pageTitle}>잔고 캡처 업로드</div>
            <div style={S.pageSub}>증권사 잔고 화면 → 종목·수량·현재가·매입단가 자동 인식</div>

            {ocrStatus === "idle" && (
              <>
                <button style={{...S.srcCard, width:"100%"}} onClick={()=>fileRef.current?.click()}>
                  <span style={{fontSize:34}}>🖼</span>
                  <div style={S.srcTitle}>이미지 선택</div>
                  <div style={S.srcSub}>갤러리 / 파일</div>
                </button>
                <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}}
                  onChange={e=>handleFile(e.target.files?.[0])} />
                <div style={{...S.card, marginTop:12, background:"#C98A2C10", border:"1px solid #C98A2C30"}}>
                  <div style={{fontSize:11,color:"#C98A2C",lineHeight:1.9}}>
                    💡 <b>매입평균가가 보이는 화면</b>을 캡처하세요.<br/>
                    수익 실현 기준 리밸런싱은 매입단가가 있어야 작동합니다.<br/>
                    (없으면 "보유" 탭에서 직접 입력 가능)
                  </div>
                </div>
              </>
            )}

            {ocrStatus === "parsing" && (
              <div style={{...S.card, textAlign:"center", display:"flex", flexDirection:"column", alignItems:"center", gap:12}}>
                <div className="spin"/>
                <div style={{fontSize:15,fontWeight:700}}>AI 분석 중</div>
                <div style={{width:"100%",height:5,background:"#E4DDCC",borderRadius:99,overflow:"hidden"}}>
                  <div style={{width:`${((ocrStep+1)/4)*100}%`,height:"100%",background:"#D97757",borderRadius:99,transition:"width .5s"}}/>
                </div>
                {["🔍 이미지 읽는 중...","🧠 종목명 감지 중...","⚡ 수량·단가 파싱 중...","✅ 검증 중..."].map((s,i)=>(
                  <div key={i} style={{fontSize:12,color:i===ocrStep?"#D97757":"#9C8F78",opacity:i===ocrStep?1:0.4}}>{s}</div>
                ))}
              </div>
            )}

            {ocrStatus === "done" && (
              <>
                {imgSrc && <img src={imgSrc} alt="" style={{width:"100%",maxHeight:180,objectFit:"contain",borderRadius:10,border:"1px solid #E4DDCC",marginBottom:12}}/>}
                {parsed.length === 0 ? (
                  <div style={{background:"#BC4B3C18",border:"1px solid #BC4B3C40",borderRadius:10,padding:"12px 14px",fontSize:12,color:"#BC4B3C",marginBottom:12,lineHeight:1.8}}>
                    ⚠️ 종목을 읽지 못했습니다. 더 선명한 캡처로 다시 시도하거나, "보유" 탭에서 직접 입력해주세요.
                  </div>
                ) : (
                  <>
                    <div style={{background:"#5B8C5A18",border:"1px solid #5B8C5A40",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#5B8C5A",marginBottom:12}}>
                      ✓ {parsed.length}개 종목 인식 — 매입단가 확인 후 확정하세요
                    </div>
                    <div style={{...S.card, padding:0, overflow:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                        <thead><tr>{["종목","수량","현재가","매입가","수익률"].map(h=>(
                          <th key={h} style={S.th}>{h}</th>))}</tr></thead>
                        <tbody>
                          {parsed.map((h,i)=>{
                            const pr = h.avgPrice>0 ? ((h.price-h.avgPrice)/h.avgPrice)*100 : null;
                            return (
                              <tr key={h.id} style={{background:i%2?"#ECE6D860":"transparent"}}>
                                <td style={S.td}>
                                  <div style={{fontWeight:700,color:"#D97757",fontSize:11}}>{h.name}</div>
                                  <div style={{fontSize:9,color:"#9C8F78"}}>{h.ticker} · {h.sector}</div>
                                </td>
                                <td style={{...S.td,textAlign:"right"}}>{h.quantity?.toLocaleString()}</td>
                                <td style={{...S.td,textAlign:"right"}}>{h.price?.toLocaleString()}</td>
                                <td style={{...S.td,textAlign:"right",color:h.avgPrice>0?"#2B241C":"#BC4B3C"}}>
                                  {h.avgPrice>0?h.avgPrice.toLocaleString():"미인식"}
                                </td>
                                <td style={{...S.td,textAlign:"right",fontWeight:700,color:pr==null?"#9C8F78":pr>=0?"#5B8C5A":"#BC4B3C"}}>
                                  {pr==null?"-":`${pr>=0?"+":""}${pr.toFixed(1)}%`}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
                <div style={{display:"flex",gap:10,marginTop:12}}>
                  <button style={S.btnSecondary} onClick={()=>{ setOcrStatus("idle"); setImgSrc(null); setParsed([]); }}>다시</button>
                  {parsed.length>0 && (
                    <>
                      <button style={S.btnSecondary} onClick={()=>{ setHoldings(prev=>[...prev,...parsed]); setTab("holdings"); }}>추가</button>
                      <button style={S.btnPrimary} onClick={()=>{ setHoldings(parsed); setTab("holdings"); }}>교체 & 저장 →</button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* ════ 보유 종목 ════ */}
        {tab === "holdings" && (
          <div className="fade">
            <div style={S.pageTitle}>보유 종목</div>
            <div style={S.pageSub}>매입단가를 채워야 수익 실현 리밸런싱이 작동합니다</div>

            {holdings.length === 0 && (
              <div style={{...S.card, textAlign:"center", padding:"30px 20px", fontSize:12, color:"#7A6F5E", lineHeight:1.9}}>
                등록된 종목이 없습니다<br/>업로드 탭에서 캡처를 올리거나 아래에서 직접 추가하세요
              </div>
            )}

            {holdings.map(h => {
              const p = h.currency==="USD"?h.price*fx:h.price;
              const a = h.currency==="USD"?(h.avgPrice||0)*fx:(h.avgPrice||0);
              const pr = a>0 ? ((p-a)/a)*100 : null;
              const pnl = a>0 ? (p-a)*(h.quantity||0) : 0;
              return (
                <div key={h.id} style={{...S.card, padding:12}}>
                  <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10}}>
                    <input value={h.name} onChange={e=>updH(h.id,{name:e.target.value})}
                      style={{...S.inp, flex:1, fontWeight:700, color:"#D97757"}} />
                    <select value={h.sector} onChange={e=>updH(h.id,{sector:e.target.value})}
                      style={{...S.inp, width:100, fontSize:11}}>
                      {targets.map(t=><option key={t.name} value={t.name}>{t.name}</option>)}
                      <option value="기타">기타</option>
                    </select>
                    <button onClick={()=>setHoldings(prev=>prev.filter(x=>x.id!==h.id))}
                      style={{background:"none",border:"none",color:"#BC4B3C",cursor:"pointer",fontSize:15,flexShrink:0}}>✕</button>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:8}}>
                    {[["수량","quantity"],["현재가","price"],["매입단가","avgPrice"]].map(([lab,key])=>(
                      <div key={key}>
                        <div style={S.miniLabel}>{lab}</div>
                        <input type="number" value={h[key]||0}
                          onChange={e=>updH(h.id,{[key]:parseFloat(e.target.value)||0})}
                          style={{...S.inp, width:"100%", textAlign:"right",
                            borderColor: key==="avgPrice" && !(h.avgPrice>0) ? "#BC4B3C60" : "#E4DDCC"}} />
                      </div>
                    ))}
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:8,borderTop:"1px solid #E4DDCC"}}>
                    <span style={{fontSize:10,color:"#9C8F78"}}>평가 ₩{fmtKRW(p*(h.quantity||0))}</span>
                    {pr==null
                      ? <span style={{fontSize:10,color:"#BC4B3C"}}>⚠ 매입단가 입력 필요</span>
                      : <span style={{fontSize:12,fontWeight:800,color:pr>=0?"#5B8C5A":"#BC4B3C"}}>
                          {pr>=0?"+":""}{pr.toFixed(1)}% · {pnl>=0?"+":""}₩{fmtKRW(Math.abs(pnl))}
                        </span>}
                  </div>
                </div>
              );
            })}

            <button onClick={addH} style={S.ghostBtn}>+ 종목 직접 추가</button>
          </div>
        )}

        {/* ════ 리밸런싱 ════ */}
        {tab === "rebalance" && (
          <div className="fade">
            <div style={S.pageTitle}>리밸런싱 제안</div>
            <div style={S.pageSub}>
              괴리율 ±{driftTol}% 초과 {profitOnly ? `· 수익률 ${minProfitPct}% 이상만 매도` : "· 수익률 무관"}
            </div>

            {/* 수익 실현 규칙 */}
            <div style={{...S.card, border:"1px solid #D9775740", background:"#D9775706"}}>
              <div style={{...S.sectionLabel, color:"#D97757", marginBottom:12}}>매도 규칙</div>
              <label style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",marginBottom:12}}>
                <div onClick={()=>setProfitOnly(!profitOnly)} style={{
                  width:40,height:22,borderRadius:99,flexShrink:0,position:"relative",transition:"background .25s",
                  background: profitOnly ? "#D97757" : "#E4DDCC" }}>
                  <div style={{position:"absolute",top:3,left:profitOnly?21:3,width:16,height:16,borderRadius:99,
                    background: profitOnly?"#F4F1EA":"#9C8F78",transition:"left .25s"}}/>
                </div>
                <div>
                  <div style={{fontSize:12,fontWeight:700}}>수익 난 종목만 매도</div>
                  <div style={{fontSize:10,color:"#7A6F5E"}}>손실 중인 종목은 매도 제안에서 제외</div>
                </div>
              </label>
              {profitOnly && (
                <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",paddingLeft:2}}>
                  <span style={{fontSize:10,color:"#9C8F78"}}>최소 수익률</span>
                  {[0,3,5,10,15,20].map(v=>(
                    <button key={v} onClick={()=>setMinProfitPct(v)} style={chip(minProfitPct===v)}>+{v}%</button>
                  ))}
                </div>
              )}
            </div>

            {/* 지정가 오프셋 */}
            <div style={S.card}>
              <div style={S.sectionLabel}>주문 지정가 기준</div>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                <span style={{fontSize:10,color:"#5B8C5A",minWidth:50}}>매도가</span>
                <span style={{fontSize:10,color:"#9C8F78"}}>현재가 +</span>
                {[0,0.5,1,2,3].map(v=>(
                  <button key={v} onClick={()=>setSellOffset(v)} style={chip(sellOffset===v)}>{v}%</button>
                ))}
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                <span style={{fontSize:10,color:"#BC4B3C",minWidth:50}}>매수가</span>
                <span style={{fontSize:10,color:"#9C8F78"}}>현재가 −</span>
                {[0,0.5,1,2,3].map(v=>(
                  <button key={v} onClick={()=>setBuyOffset(v)} style={chip(buyOffset===v)}>{v}%</button>
                ))}
              </div>
            </div>

            {/* 괴리율 버퍼 */}
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,flexWrap:"wrap"}}>
              <span style={{fontSize:10,letterSpacing:1,color:"#9C8F78"}}>괴리율 버퍼</span>
              {[2,3,5,7,10].map(v=>(
                <button key={v} onClick={()=>setDriftTol(v)} style={chip(driftTol===v)}>±{v}%</button>
              ))}
            </div>

            {/* 요약 */}
            {holdings.length>0 && (
              <div style={S.hscroll}>
                {[
                  { l:`매도 ${allSells.length}건`, v:`₩${fmtKRW(sellProceeds)}`, c:"#BC4B3C" },
                  { l:"예상 실현손익", v:`${totalRealize>=0?"+":""}₩${fmtKRW(Math.abs(totalRealize))}`, c: totalRealize>=0?"#5B8C5A":"#BC4B3C" },
                  { l:"매도 보류", v:`${heldTotal}건`, c:"#C98A2C" },
                ].map((k,i)=>(
                  <div key={i} style={{...S.kpiCard, borderColor:`${k.c}40`}}>
                    <div style={S.kpiLabel}>{k.l}</div>
                    <div style={{...S.kpiValue, color:k.c}}>{k.v}</div>
                  </div>
                ))}
              </div>
            )}

            {holdings.length === 0
              ? <div style={{textAlign:"center",padding:"40px 20px",fontSize:13,color:"#7A6F5E",lineHeight:2}}>
                  보유 종목을 먼저 등록해주세요
                </div>
              : sectorResults.filter(s=>s.needsAction).length === 0
              ? <div style={{textAlign:"center",padding:"40px 20px",fontSize:15,color:"#7A6F5E",lineHeight:2}}>✅<br/>모든 섹터가 목표 비중 내에 있습니다</div>
              : sectorResults.filter(s=>s.needsAction).map((s,i)=>{
                const dc = s.diff>0?"#5B8C5A":"#BC4B3C";
                const trades = s.trades.filter(t=>t.action!=="HOLD");
                const isOpen = expanded === s.name;
                return (
                  <div key={i} onClick={()=>setExpanded(isOpen?null:s.name)}
                    style={{background:"#FFFFFF",border:`1px solid ${s.color}50`,borderRadius:14,display:"flex",marginBottom:12,overflow:"hidden",cursor:"pointer"}}>
                    <div style={{width:4,background:s.color,flexShrink:0}}/>
                    <div style={{flex:1,padding:"12px 12px 10px"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <div style={{width:10,height:10,borderRadius:2,background:s.color}}/>
                          <span style={{fontSize:14,fontWeight:700}}>{s.name}</span>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <span style={badge(dc)}>{s.diff>0?"▲ 매수":"▼ 매도"} 필요</span>
                          <div style={{fontSize:10,fontWeight:700,marginTop:4,color:Math.abs(s.drift)>5?"#BC4B3C":"#C98A2C"}}>
                            괴리율 {s.drift>0?"+":""}{s.drift.toFixed(1)}%
                          </div>
                        </div>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                        <div>
                          <div style={S.diffLabel}>필요 조정</div>
                          <div style={{fontFamily:"'Fraunces',serif",fontSize:19,fontWeight:800,color:dc}}>
                            {s.diff>0?"+":"-"}₩{fmtKRW(Math.abs(s.diff))}
                          </div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={S.diffLabel}>현재→목표</div>
                          <div style={{fontSize:14,fontWeight:600}}>{s.currentPct.toFixed(1)}% → {s.targetPct}%</div>
                        </div>
                      </div>
                      <Bar pct={s.currentPct} color={s.color} solid />
                      <Bar pct={s.targetPct} color={s.color} />
                      {trades.length>0 && (
                        <div style={{fontSize:11,fontWeight:700,color:s.color,textAlign:"center",padding:"6px 0 0"}}>
                          {isOpen?"▲ 숨기기":`▼ 주문 상세 (${trades.length}건)`}
                        </div>
                      )}
                      {isOpen && trades.map((t,ti)=>{
                        const isWait = t.action==="WAIT";
                        const ac = isWait ? "#C98A2C" : t.action==="BUY"?"#5B8C5A":"#BC4B3C";
                        return (
                          <div key={ti} style={{padding:"10px 0",borderBottom:ti<trades.length-1?"1px solid #E4DDCC":"none"}}>
                            <div style={{display:"flex",alignItems:"center",gap:10}}>
                              <div style={{width:44,height:44,borderRadius:8,background:`${ac}20`,border:`1px solid ${ac}50`,color:ac,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:800,flexShrink:0}}>
                                {isWait?"보류":t.action==="BUY"?"매수":"매도"}
                              </div>
                              <div style={{flex:1,minWidth:0}}>
                                <div style={{fontSize:13,fontWeight:600}}>{t.holding.name}</div>
                                <div style={{fontSize:10,color:"#9C8F78"}}>
                                  {t.holding.ticker}
                                  {t.profitPct!=null && <span style={{color:t.profitPct>=0?"#5B8C5A":"#BC4B3C",marginLeft:6,fontWeight:700}}>
                                    {t.profitPct>=0?"+":""}{t.profitPct.toFixed(1)}%
                                  </span>}
                                </div>
                              </div>
                              <div style={{textAlign:"right",flexShrink:0}}>
                                <div style={{fontSize:15,fontWeight:800,color:ac}}>
                                  {isWait?"—":`${t.action==="BUY"?"+":"-"}${t.quantity}주`}
                                </div>
                                <div style={{fontSize:10,color:"#9C8F78"}}>≈ ₩{fmtKRW(t.amtKRW)}</div>
                              </div>
                            </div>
                            {isWait ? (
                              <div style={{marginTop:8,background:"#C98A2C12",borderLeft:"2px solid #C98A2C",borderRadius:"0 6px 6px 0",padding:"7px 10px",fontSize:10,color:"#C98A2C",lineHeight:1.7}}>
                                수익률 {t.profitPct?.toFixed(1)}%로 기준({minProfitPct}%) 미달 → 매도 보류<br/>
                                {t.breakEvenTarget && <>목표가 <b>₩{Math.round(t.breakEvenTarget).toLocaleString()}</b> 도달 시 매도 대상</>}
                              </div>
                            ) : (
                              <div style={{marginTop:8,display:"flex",gap:8,flexWrap:"wrap"}}>
                                <div style={S.orderChip}>
                                  <span style={{color:"#9C8F78"}}>지정가</span>
                                  <b style={{color:ac}}>₩{Math.round(t.limitPrice).toLocaleString()}</b>
                                </div>
                                {t.action==="SELL" && t.avgKRWv>0 && (
                                  <div style={S.orderChip}>
                                    <span style={{color:"#9C8F78"}}>실현손익</span>
                                    <b style={{color:t.realized>=0?"#5B8C5A":"#BC4B3C"}}>
                                      {t.realized>=0?"+":""}₩{fmtKRW(Math.abs(t.realized))}
                                    </b>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            }

            {/* 갈아타기 제안 (시황 검색 반영) */}
            <button onClick={suggestSwitch} disabled={switchLoading||holdings.length===0}
              style={{...S.btnPrimary, width:"100%", marginTop:6, opacity: holdings.length===0?0.4:1, display:"flex", alignItems:"center", justifyContent:"center", gap:8}}>
              <span>🔍</span>{switchLoading?"시황 검색+분석 중...":"오늘 시황 기반 리밸런싱 제안"}
            </button>
            {lastSwitchAt && !switchLoading && (
              <div style={{textAlign:"center",fontSize:10,color:"#9C8F78",marginTop:6}}>
                마지막 분석: {timeAgo(lastSwitchAt)} · 크레딧 절약을 위해 하루 1~2회 권장
              </div>
            )}

            {switchLoading && (
              <div style={{...S.card, marginTop:12, textAlign:"center", padding:30, display:"flex", flexDirection:"column", alignItems:"center", gap:14}}>
                <div className="spin"/>
                <div style={{color:"#7A6F5E",fontSize:12,lineHeight:1.8}}>
                  오늘 시황을 검색하고<br/>내 포트폴리오·수익률·목표비중과 종합 분석 중입니다
                </div>
              </div>
            )}

            {switchResult && !switchLoading && (switchResult.error ? (
              <div style={{...S.card, marginTop:12, borderColor:"#BC4B3C40"}}>
                <div style={{fontSize:12,color:"#BC4B3C"}}>분석에 실패했습니다. 잠시 후 다시 시도해주세요.</div>
                {switchResult.msg && <div style={{fontSize:10,color:"#9C8F78",marginTop:6}}>({switchResult.msg})</div>}
              </div>
            ) : (
              <div className="fade" style={{marginTop:12}}>
                {switchResult.marketSummary && (
                  <div style={{...S.card, borderColor:"#5B7A9940", background:"#5B7A9908"}}>
                    <div style={{...S.sectionLabel, color:"#5B7A99", display:"flex", alignItems:"center", gap:6}}>
                      <span>🔍</span> 오늘 시황 요약
                    </div>
                    <div style={{fontSize:12,lineHeight:1.9}}>{switchResult.marketSummary}</div>
                  </div>
                )}

                {switchResult.suggestedRule?.changed && (
                  <div style={{...S.card, borderColor:"#C98A2C40", background:"#C98A2C08"}}>
                    <div style={{...S.sectionLabel, color:"#C98A2C"}}>💡 매도 기준 조정 제안</div>
                    <div style={{fontSize:12,lineHeight:1.8,marginBottom:10}}>{switchResult.suggestedRule.reason}</div>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <div style={S.orderChip}>
                        <span style={{color:"#9C8F78"}}>현재</span><b>{minProfitPct}%</b>
                      </div>
                      <span style={{color:"#9C8F78"}}>→</span>
                      <div style={S.orderChip}>
                        <span style={{color:"#9C8F78"}}>제안</span><b style={{color:"#C98A2C"}}>{switchResult.suggestedRule.minProfitPct}%</b>
                      </div>
                      <button onClick={()=>{ setMinProfitPct(switchResult.suggestedRule.minProfitPct); }}
                        style={{marginLeft:"auto", background:"#C98A2C", color:"#FFFFFF", border:"none", borderRadius:99, padding:"7px 14px", fontFamily:"inherit", fontSize:11, fontWeight:700, cursor:"pointer"}}>
                        적용하기
                      </button>
                    </div>
                  </div>
                )}

                <div style={{...S.card, border:"1px solid #D9775740", background:"#D9775706"}}>
                  <div style={{...S.sectionLabel, color:"#D97757"}}>포트폴리오 진단</div>
                  <div style={{fontSize:12,lineHeight:1.9}}>{switchResult.diagnosis}</div>
                </div>

                {switchResult.sells?.length>0 && (
                  <>
                    <div style={{...S.sectionLabel, padding:"0 4px", color:"#BC4B3C"}}>매도 제안</div>
                    {switchResult.sells.map((r,i)=>(
                      <div key={i} style={{...S.card, borderColor:"#BC4B3C30", padding:13}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                          <div>
                            <span style={{fontSize:13,fontWeight:700}}>{r.name}</span>
                            <span style={{fontSize:10,color:"#9C8F78",marginLeft:6}}>{r.ticker}</span>
                          </div>
                          {r.profitPct!=null && <span style={badge(r.profitPct>=0?"#5B8C5A":"#BC4B3C")}>
                            {r.profitPct>=0?"+":""}{r.profitPct}%</span>}
                        </div>
                        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:8}}>
                          <div style={S.orderChip}><span style={{color:"#9C8F78"}}>수량</span><b style={{color:"#BC4B3C"}}>{r.quantity}주</b></div>
                          <div style={S.orderChip}><span style={{color:"#9C8F78"}}>희망가</span><b style={{color:"#BC4B3C"}}>₩{r.limitPrice?.toLocaleString()}</b></div>
                        </div>
                        <div style={{fontSize:11,color:"#7A6F5E",lineHeight:1.7}}>{r.reason}</div>
                      </div>
                    ))}
                  </>
                )}

                {switchResult.holds?.length>0 && (
                  <>
                    <div style={{...S.sectionLabel, padding:"0 4px", color:"#C98A2C"}}>보유 유지 (매도 제외)</div>
                    <div style={S.card}>
                      {switchResult.holds.map((r,i)=>(
                        <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:i<switchResult.holds.length-1?10:0}}>
                          <span style={{fontSize:11,fontWeight:700,color:"#C98A2C",flexShrink:0,minWidth:70}}>{r.name}</span>
                          <span style={{fontSize:11,color:"#7A6F5E",lineHeight:1.7}}>{r.reason}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {switchResult.buys?.length>0 && (
                  <>
                    <div style={{...S.sectionLabel, padding:"0 4px", color:"#5B8C5A"}}>매수 제안 (갈아타기)</div>
                    {switchResult.buys.map((r,i)=>(
                      <div key={i} style={{...S.card, borderColor:"#5B8C5A30", padding:13}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                          <div>
                            <span style={{fontSize:13,fontWeight:700}}>{r.name}</span>
                            <span style={{fontSize:10,color:"#9C8F78",marginLeft:6}}>{r.ticker}</span>
                          </div>
                          {r.sector && <span style={badge("#5B8C5A")}>{r.sector}</span>}
                        </div>
                        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:8}}>
                          <div style={S.orderChip}><span style={{color:"#9C8F78"}}>수량</span><b style={{color:"#5B8C5A"}}>{r.quantity}주</b></div>
                          <div style={S.orderChip}><span style={{color:"#9C8F78"}}>희망가</span><b style={{color:"#5B8C5A"}}>₩{r.limitPrice?.toLocaleString()}</b></div>
                          {r.amountKRW>0 && <div style={S.orderChip}><span style={{color:"#9C8F78"}}>금액</span><b>₩{fmtKRW(r.amountKRW)}</b></div>}
                        </div>
                        <div style={{fontSize:11,color:"#7A6F5E",lineHeight:1.7}}>{r.reason}</div>
                      </div>
                    ))}
                  </>
                )}

                <div style={{...S.card, borderColor:"#C98A2C40", background:"#C98A2C08"}}>
                  <div style={{fontSize:11,color:"#C98A2C",lineHeight:1.9}}>
                    ⚠️ <b>참고용 정보입니다.</b> 제시된 가격은 예측이 아니라 현재가 기준 참고 구간이며,
                    실제 체결가·수수료·세금은 반영되지 않았습니다. 최종 투자 판단과 책임은 본인에게 있습니다.
                    {switchResult.caution && <><br/><br/>{switchResult.caution}</>}
                  </div>
                </div>
              </div>
            ))}

            {/* 목표 비중 설정 */}
            <div style={{...S.card, marginTop:16}}>
              <div style={S.sectionLabel}>목표 비중 설정 <span style={{fontSize:9,color:"#5B8C5A"}}>(자동 저장)</span></div>
              {targets.map((t,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                  <div style={{width:10,height:10,borderRadius:2,background:t.color,flexShrink:0}}/>
                  <input type="text" value={t.name}
                    onChange={e=>setTargets(prev=>prev.map((s,j)=>j===i?{...s,name:e.target.value}:s))}
                    style={{...S.inp, flex:1, fontSize:12}} />
                  <input type="number" value={t.targetPct}
                    onChange={e=>setTargets(prev=>prev.map((s,j)=>j===i?{...s,targetPct:parseFloat(e.target.value)||0}:s))}
                    style={{...S.inp, width:58, textAlign:"right"}} />
                  <span style={{fontSize:13,fontWeight:700,color:t.color,minWidth:14}}>%</span>
                  <button onClick={()=>setTargets(prev=>prev.filter((_,j)=>j!==i))}
                    style={{background:"none",border:"none",color:"#BC4B3C",cursor:"pointer",fontSize:14,flexShrink:0}}>✕</button>
                </div>
              ))}
              <button onClick={()=>setTargets(prev=>[...prev,{name:"새 섹터",targetPct:0,color:SECTOR_COLORS[prev.length%SECTOR_COLORS.length]}])}
                style={{...S.ghostBtn, marginBottom:10}}>+ 섹터 추가</button>
              <div style={{fontFamily:"'Fraunces',serif",fontSize:15,fontWeight:800,textAlign:"right",paddingTop:8,borderTop:"1px solid #E4DDCC",color:Math.abs(targetSum-100)<0.1?"#5B8C5A":"#BC4B3C"}}>
                합계: {targetSum}% {Math.abs(targetSum-100)<0.1?"✓":"← 100% 맞춰주세요"}
              </div>
            </div>
          </div>
        )}

        {/* ════ 시황 ════ */}
        {tab === "news" && (
          <div className="fade">
            <div style={S.pageTitle}>AI 시황 분석</div>
            <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"#D9775710",border:"1px solid #D9775730",borderRadius:6,padding:"5px 10px",fontSize:10,color:"#D97757",marginBottom:14}}>
              🛡 코스피200 · 대형 우량주 중심 분석
            </div>

            {/* ── 신규 종목 발굴 ── */}
            <div style={S.card}>
              <div style={S.sectionLabel}>🧭 신규 종목 발굴 <span style={{fontSize:9,color:"#9C8F78",textTransform:"none",letterSpacing:0}}>(보유 종목과 무관하게 새 아이디어)</span></div>
              <div style={{display:"flex",gap:8,marginBottom:10}}>
                <button onClick={()=>setDiscMarket("domestic")} style={{...chip(discMarket==="domestic"), flex:1, padding:"8px"}}>🇰🇷 국내</button>
                <button onClick={()=>setDiscMarket("overseas")} style={{...chip(discMarket==="overseas"), flex:1, padding:"8px"}}>🌐 해외</button>
              </div>
              <input value={discStyle} onChange={e=>setDiscStyle(e.target.value)}
                placeholder="예) 배당주, AI 관련주, 저평가 가치주 (비워두면 알아서 추천)"
                style={{...S.inp, width:"100%", marginBottom:10}} />
              <button onClick={discoverStocks} disabled={discLoading}
                style={{...S.btnPrimary, width:"100%"}}>
                {discLoading ? "발굴 중..." : `${discMarket==="domestic"?"국내":"해외"} 종목 추천받기`}
              </button>
            </div>

            {discLoading && (
              <div style={{...S.card, textAlign:"center", padding:30, display:"flex", flexDirection:"column", alignItems:"center", gap:14}}>
                <div className="spin"/><div style={{color:"#7A6F5E",fontSize:12}}>{discMarket==="domestic"?"국내":"해외"} 종목을 찾고 있습니다...</div>
              </div>
            )}

            {discResult && !discLoading && (discResult.error ? (
              <div style={{...S.card, borderColor:"#BC4B3C40"}}>
                <div style={{fontSize:12,color:"#BC4B3C"}}>발굴에 실패했습니다. 잠시 후 다시 시도해주세요.</div>
                {discResult.msg && <div style={{fontSize:10,color:"#9C8F78",marginTop:6}}>({discResult.msg})</div>}
              </div>
            ) : (
              <div className="fade">
                {discResult.picks?.map((r,i)=>(
                  <div key={i} style={{...S.card, display:"flex", gap:12, alignItems:"flex-start", padding:14}}>
                    <div style={{width:52,height:52,borderRadius:10,background:"#5B7A9920",border:"1px solid #5B7A9940",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      <span style={{fontSize:10,fontWeight:800,color:"#5B7A99",letterSpacing:0.5}}>{r.ticker}</span>
                    </div>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                        <span style={{fontSize:13,fontWeight:700}}>{r.name}</span>
                        {r.sector && <span style={badge("#5B7A99")}>{r.sector}</span>}
                        {r.style && <span style={badge("#D97757")}>{r.style}</span>}
                      </div>
                      {r.marketCap && <div style={{fontSize:10,color:"#9C8F78",marginBottom:4}}>시총 {r.marketCap}</div>}
                      <div style={{fontSize:11,color:"#7A6F5E",lineHeight:1.7}}>{r.reason}</div>
                      {r.note && <div style={{fontSize:10,color:"#C98A2C",marginTop:6}}>💡 {r.note}</div>}
                    </div>
                  </div>
                ))}
                <div style={{...S.card, borderColor:"#C98A2C40", background:"#C98A2C08"}}>
                  <div style={{fontSize:11,color:"#C98A2C",lineHeight:1.9}}>
                    ⚠️ 투자 아이디어 참고용입니다. 매수 추천이나 수익 보장이 아니며, 최종 판단과 책임은 본인에게 있습니다.
                    {discResult.caution && <><br/><br/>{discResult.caution}</>}
                  </div>
                </div>
              </div>
            ))}

            {/* ── 오늘 시황 자동 분석 ── */}
            <button onClick={autoFetchNews} disabled={newsLoading}
              style={{...S.btnPrimary, width:"100%", marginBottom:14, display:"flex", alignItems:"center", justifyContent:"center", gap:8}}>
              <span>🔍</span>{newsLoading && newsSource!=="manual" ? "오늘 시황 검색 중..." : "오늘 시황 자동 분석"}
            </button>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
              <div style={{flex:1,height:1,background:"#E4DDCC"}}/>
              <span style={{fontSize:9,color:"#9C8F78",letterSpacing:1}}>또는 직접 뉴스 입력</span>
              <div style={{flex:1,height:1,background:"#E4DDCC"}}/>
            </div>

            <div style={S.hscroll}>
              {[
                { l:"🏦 금통위", t:"한국은행 금통위 기준금리 동결. 원/달러 환율 1,380원대. 외국인 순매수 전환." },
                { l:"💾 반도체", t:"삼성전자 HBM4 양산 준비. SK하이닉스 HBM 공급 확대. 메모리 가격 상승세." },
                { l:"🔋 2차전지", t:"미국 IRA 보조금 정책 변화. 전기차 캐즘 지속. 배터리 소재 단가 하락." },
                { l:"📊 코스피", t:"코스피 외국인 수급 개선. 밸류업 프로그램 기대감. 저PBR 금융주 강세." },
              ].map((q,i)=>(
                <button key={i} onClick={()=>setNewsText(q.t)} style={{flexShrink:0,background:"#FFFFFF",border:"1px solid #E4DDCC",borderRadius:99,padding:"7px 14px",color:"#7A6F5E",fontFamily:"inherit",fontSize:11,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>
                  {q.l}
                </button>
              ))}
            </div>

            <div style={{...S.card, padding:0, overflow:"hidden"}}>
              <div style={{padding:"12px 16px 0",display:"flex",justifyContent:"space-between"}}>
                <span style={S.sectionLabel}>뉴스 / 시황 입력</span>
                {newsText && <button style={{background:"none",border:"none",color:"#BC4B3C",cursor:"pointer",fontSize:12}} onClick={()=>setNewsText("")}>✕</button>}
              </div>
              <textarea value={newsText} onChange={e=>setNewsText(e.target.value)}
                placeholder={"예) 한국은행 기준금리 동결, 반도체 수출 증가...\n삼성전자 실적 발표 예상치 상회..."}
                style={{width:"100%",minHeight:110,background:"transparent",border:"none",padding:"10px 16px",color:"#2B241C",fontFamily:"inherit",fontSize:13,lineHeight:1.7,resize:"vertical"}} />
              <div style={{padding:"8px 16px 12px",display:"flex",justifyContent:"space-between",alignItems:"center",borderTop:"1px solid #E4DDCC"}}>
                <span style={{fontSize:11,color:"#9C8F78"}}>{newsText.length}자</span>
                <button onClick={()=>{ setNewsSource("manual"); analyzeNews(); }} disabled={!newsText.trim()||newsLoading}
                  style={{...S.btnPrimary, flex:"none", padding:"8px 20px", opacity:!newsText.trim()?0.4:1}}>
                  {newsLoading && newsSource==="manual" ?"분석 중...":"AI 분석 →"}
                </button>
              </div>
            </div>


            {newsLoading && (
              <div style={{...S.card, textAlign:"center", padding:40, display:"flex", flexDirection:"column", alignItems:"center", gap:16}}>
                <div className="spin"/><div style={{color:"#7A6F5E",fontSize:13}}>시황을 분석하고 있습니다...</div>
              </div>
            )}

            {newsResult && !newsLoading && (
              <div className="fade">
                <div style={S.card}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <div style={{display:"flex",gap:6,alignItems:"center"}}>
                      <span style={badge(sentColor[newsResult.sentiment]||"#C98A2C")}>
                        {newsResult.sentiment==="bullish"?"▲ BULLISH":newsResult.sentiment==="bearish"?"▼ BEARISH":"◆ NEUTRAL"}
                      </span>
                      {newsSource==="auto" && <span style={badge("#5B7A99")}>🔍 웹 검색</span>}
                    </div>
                    <span style={{fontSize:11,color:"#9C8F78"}}>{new Date().toLocaleDateString("ko-KR")}</span>
                  </div>
                  <div style={{fontSize:13,lineHeight:1.9,marginBottom:12}}>{newsResult.summary}</div>
                  <div style={{background:"#ECE6D8",borderLeft:"3px solid #D97757",borderRadius:"0 8px 8px 0",padding:"10px 14px",fontSize:12,color:"#7A6F5E",lineHeight:1.8}}>
                    <span style={{color:"#D97757",fontWeight:600}}>거시경제 </span>{newsResult.macro}
                  </div>
                </div>

                {newsResult.leaders?.length>0 && (
                  <>
                    <div style={{...S.sectionLabel, padding:"0 4px"}}>주도 테마</div>
                    <div style={S.card}>
                      {newsResult.leaders.map((l,i)=>(
                        <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:i<newsResult.leaders.length-1?10:0}}>
                          <span style={{fontSize:11,fontWeight:800,color:"#D97757",flexShrink:0,minWidth:60}}>{l.theme}</span>
                          <span style={{fontSize:11,color:"#7A6F5E",lineHeight:1.7}}>{l.reason}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                <div style={{...S.sectionLabel, padding:"0 4px"}}>섹터별 영향도</div>
                <div style={S.hscroll}>
                  {newsResult.sectorImpact?.map((s,i)=>{
                    const ic = s.impact==="positive"?"#5B8C5A":s.impact==="negative"?"#BC4B3C":"#C98A2C";
                    return (
                      <div key={i} style={{flexShrink:0,width:150,background:"#FFFFFF",border:`1px solid ${ic}40`,borderRadius:12,padding:12,display:"flex",flexDirection:"column",gap:6}}>
                        <div style={{width:32,height:32,borderRadius:16,background:`${ic}20`,color:ic,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:800}}>
                          {s.impact==="positive"?"▲":s.impact==="negative"?"▼":"→"}
                        </div>
                        <div style={{fontSize:12,fontWeight:700}}>{s.sector}</div>
                        <div style={{fontSize:10,color:"#7A6F5E",lineHeight:1.6}}>{s.reason}</div>
                      </div>
                    );
                  })}
                </div>

                {newsResult.bluechipRecs?.length>0 && (
                  <>
                    <div style={{...S.sectionLabel, padding:"8px 4px", display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                      관심 종목
                      <span style={{fontSize:9,color:"#BC4B3C",background:"#BC4B3C15",border:"1px solid #BC4B3C30",padding:"2px 8px",borderRadius:99,letterSpacing:1}}>테마주 배제</span>
                    </div>
                    {newsResult.bluechipRecs.map((r,i)=>(
                      <div key={i} style={{...S.card, display:"flex", gap:12, alignItems:"flex-start", padding:14}}>
                        <div style={{width:52,height:52,borderRadius:10,background:"#D9775720",border:"1px solid #D9775740",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                          <span style={{fontSize:10,fontWeight:800,color:"#D97757",letterSpacing:0.5}}>{r.ticker}</span>
                        </div>
                        <div style={{flex:1}}>
                          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                            <span style={{fontSize:13,fontWeight:700}}>{r.name}</span>
                            {r.category && <span style={badge("#5B8C5A")}>{r.category}</span>}
                          </div>
                          {r.marketCap && <div style={{fontSize:10,color:"#9C8F78",marginBottom:4}}>시총 {r.marketCap}</div>}
                          <div style={{fontSize:11,color:"#7A6F5E",lineHeight:1.7}}>{r.reason}</div>
                        </div>
                      </div>
                    ))}
                  </>
                )}

                {newsResult.risks?.length>0 && (
                  <div style={S.card}>
                    <div style={{...S.sectionLabel, color:"#BC4B3C"}}>리스크 요인</div>
                    {newsResult.risks.map((r,i)=>(
                      <div key={i} style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:10}}>
                        <div style={{width:5,height:5,borderRadius:3,background:"#BC4B3C",marginTop:6,flexShrink:0}}/>
                        <span style={{fontSize:12,color:"#7A6F5E",lineHeight:1.8}}>{r}</span>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{...S.card, border:"1px solid #D9775740", background:"#D9775708"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                    <span style={{fontSize:18}}>💼</span>
                    <span style={{...S.sectionLabel, color:"#D97757", marginBottom:0}}>포트폴리오 대응</span>
                  </div>
                  <div style={{fontSize:13,lineHeight:1.9}}>{newsResult.portfolioAction}</div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <nav style={S.tabbar}>
        {[["home","◈","홈"],["upload","📷","업로드"],["holdings","📋","보유"],["rebalance","⚖","리밸런싱"],["news","📡","시황"]].map(([key,icon,label])=>(
          <button key={key} onClick={()=>setTab(key)} style={{
            flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:3,
            padding:"10px 0 8px", background:"none", border:"none", cursor:"pointer", position:"relative",
            borderTop: tab===key?"2px solid #D97757":"2px solid transparent" }}>
            <div style={{position:"relative",display:"inline-block"}}>
              <span style={{fontSize:17,opacity:tab===key?1:0.35}}>{icon}</span>
              {key==="rebalance" && alertCount>0 && (
                <span style={{position:"absolute",top:-3,right:-8,minWidth:14,height:14,borderRadius:99,background:"#BC4B3C",color:"#fff",fontSize:8,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px"}}>{alertCount}</span>
              )}
            </div>
            <span style={{fontSize:8.5,letterSpacing:1,color:tab===key?"#D97757":"#9C8F78",fontWeight:tab===key?700:400}}>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function Bar({ pct, color, solid }) {
  return (
    <div style={{height:7,background:"#E4DDCC",borderRadius:99,display:"flex",alignItems:"center",marginBottom:3}}>
      <div style={{ width:`${Math.min(pct,100)}%`, height:"100%", borderRadius:99, minWidth:2, transition:"width .5s",
        background: solid ? color : `${color}40`, border: solid ? "none" : `1px dashed ${color}80` }}/>
      <span style={{fontSize:10,marginLeft:6,whiteSpace:"nowrap",color:solid?color:"#9C8F78"}}>{pct.toFixed(1)}%</span>
    </div>
  );
}

const badge = (c) => ({
  fontSize:10, fontWeight:700, letterSpacing:1, padding:"3px 9px", borderRadius:99,
  color:c, background:`${c}20`, border:`1px solid ${c}40`, whiteSpace:"nowrap",
});

const chip = (on) => ({
  background: on?"#D9775715":"#FFFFFF", border:`1px solid ${on?"#D9775750":"#E4DDCC"}`,
  borderRadius:6, padding:"4px 9px", color: on?"#D97757":"#9C8F78",
  fontFamily:"inherit", fontSize:11, cursor:"pointer",
});

const S = {
  app: { minHeight:"100vh", background:"#F4F1EA", color:"#2B241C", fontFamily:"'Inter',sans-serif", fontSize:13, maxWidth:480, margin:"0 auto", display:"flex", flexDirection:"column", position:"relative" },
  topbar: { position:"sticky", top:0, zIndex:100, background:"#ECE6D8", borderBottom:"1px solid #E4DDCC", padding:"12px 16px", display:"flex", alignItems:"center", justifyContent:"space-between" },
  logo: { fontFamily:"'Syne',sans-serif", fontSize:17, fontWeight:800, letterSpacing:0.5 },
  main: { flex:1, padding:16, paddingBottom:80, overflowY:"auto" },
  heroLabel: { fontSize:10, letterSpacing:3, textTransform:"uppercase", color:"#9C8F78", marginBottom:6 },
  heroValue: { fontFamily:"'Syne',sans-serif", fontSize:34, fontWeight:800, letterSpacing:-1, marginBottom:8 },
  hscroll: { display:"flex", overflowX:"auto", gap:10, paddingBottom:4, marginBottom:16 },
  kpiCard: { flexShrink:0, background:"#FFFFFF", border:"1px solid #E4DDCC", borderRadius:10, padding:"10px 14px", minWidth:110 },
  kpiLabel: { fontSize:9, letterSpacing:1.5, color:"#9C8F78", marginBottom:4 },
  kpiValue: { fontFamily:"'Syne',sans-serif", fontSize:16, fontWeight:800 },
  card: { background:"#FFFFFF", border:"1px solid #E4DDCC", borderRadius:14, padding:16, marginBottom:14 },
  sectionLabel: { fontSize:10, letterSpacing:2, textTransform:"uppercase", color:"#9C8F78", marginBottom:14 },
  miniLabel: { fontSize:9, color:"#9C8F78", marginBottom:3 },
  donutCenter: { position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" },
  ctaBanner: { width:"100%", background:"#BC4B3C18", border:"1px solid #BC4B3C50", borderRadius:14, padding:16, display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer", marginBottom:14, fontFamily:"inherit" },
  pageTitle: { fontFamily:"'Syne',sans-serif", fontSize:20, fontWeight:800, marginBottom:4 },
  pageSub: { fontSize:11, color:"#9C8F78", marginBottom:16, lineHeight:1.6 },
  srcCard: { background:"#FFFFFF", border:"1px solid #E4DDCC", borderRadius:14, padding:"24px 12px", display:"flex", flexDirection:"column", alignItems:"center", gap:8, cursor:"pointer", fontFamily:"inherit" },
  srcTitle: { fontSize:13, fontWeight:700, color:"#2B241C" },
  srcSub: { fontSize:10, color:"#9C8F78" },
  th: { padding:"8px 10px", textAlign:"left", fontSize:9, letterSpacing:1, color:"#9C8F78", background:"#ECE6D8", borderBottom:"1px solid #E4DDCC", whiteSpace:"nowrap" },
  td: { padding:"9px 10px", borderTop:"1px solid rgba(28,38,56,0.4)", whiteSpace:"nowrap" },
  inp: { background:"#ECE6D8", border:"1px solid #E4DDCC", borderRadius:6, padding:"6px 8px", color:"#2B241C", fontFamily:"inherit", fontSize:12 },
  orderChip: { background:"#ECE6D8", border:"1px solid #E4DDCC", borderRadius:6, padding:"5px 9px", fontSize:10, display:"flex", gap:5, alignItems:"center" },
  btnPrimary: { flex:1, background:"#D97757", color:"#F4F1EA", border:"none", borderRadius:99, padding:"13px 20px", fontFamily:"inherit", fontSize:13, fontWeight:700, cursor:"pointer" },
  btnSecondary: { flex:1, background:"transparent", color:"#D97757", border:"1.5px solid #D97757", borderRadius:99, padding:"13px 14px", fontFamily:"inherit", fontSize:12, fontWeight:700, cursor:"pointer" },
  ghostBtn: { width:"100%", background:"transparent", border:"1px dashed #E4DDCC", borderRadius:10, padding:"10px", color:"#9C8F78", fontFamily:"inherit", fontSize:11, cursor:"pointer" },
  diffLabel: { fontSize:9, letterSpacing:1.5, color:"#9C8F78", marginBottom:2 },
  tabbar: { position:"sticky", bottom:0, width:"100%", background:"#ECE6D8", borderTop:"1px solid #E4DDCC", display:"flex", zIndex:100 },
};
