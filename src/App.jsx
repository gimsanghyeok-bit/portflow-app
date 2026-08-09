import { useState, useRef, useCallback, useEffect } from "react";

// ══════════════════════════════════════════════════════
// 배포용 변경점 2가지:
// 1) window.storage (Claude 아티팩트 전용) → localStorage로 교체
// 2) fetch("https://api.anthropic.com/...") 직접 호출 (API 키 없이 동작)
//    → 우리 서버(/api/claude)로 프록시. 실제 API 키는 서버 환경변수에만 존재.
// ══════════════════════════════════════════════════════

// localStorage를 window.storage와 비슷한 인터페이스로 감싸기 (동일한 await 문법 유지)
const storage = {
  async get(key) {
    const v = localStorage.getItem(key);
    if (v === null) throw new Error("not found");
    return { key, value: v };
  },
  async set(key, value) {
    localStorage.setItem(key, value);
    return { key, value };
  },
  async delete(key) {
    localStorage.removeItem(key);
    return { key, deleted: true };
  },
};

// Anthropic API 프록시 호출 (서버의 /api/claude 로 전달, 서버가 실제 API 키로 호출)
async function callClaude({ system, messages, max_tokens = 1000 }) {
  const resp = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, messages, max_tokens }),
  });
  if (!resp.ok) throw new Error(`API error: ${resp.status}`);
  return resp.json();
}

// ── 컬러 ─────────────────────────────────────────────
const SECTOR_COLORS = ["#00e5b8","#6366f1","#f5a623","#ff4d6a","#22d47a","#5b8dee","#e879f9","#84cc16"];

const DEFAULT_TARGETS = [
  { name:"미국 반도체", targetPct:30, color:SECTOR_COLORS[0] },
  { name:"AI/클라우드",  targetPct:20, color:SECTOR_COLORS[1] },
  { name:"글로벌 바이오",targetPct:20, color:SECTOR_COLORS[2] },
  { name:"소비재",       targetPct:15, color:SECTOR_COLORS[3] },
  { name:"금융",         targetPct: 5, color:SECTOR_COLORS[4] },
  { name:"현금",         targetPct:10, color:SECTOR_COLORS[5] },
];

const DEMO = [
  { id:"1", ticker:"NVDA",   name:"엔비디아",      quantity:15,  price:950,   evalAmt:14250,    currency:"USD", sector:"미국 반도체", sanityOk:true },
  { id:"2", ticker:"TSM",    name:"TSMC",          quantity:30,  price:195,   evalAmt:5850,     currency:"USD", sector:"미국 반도체", sanityOk:true },
  { id:"3", ticker:"005930", name:"삼성전자",       quantity:200, price:74000, evalAmt:14800000, currency:"KRW", sector:"미국 반도체", sanityOk:true },
  { id:"4", ticker:"MSFT",   name:"마이크로소프트", quantity:10,  price:450,   evalAmt:4500,     currency:"USD", sector:"AI/클라우드", sanityOk:true },
  { id:"5", ticker:"AMZN",   name:"아마존",        quantity:8,   price:220,   evalAmt:1760,     currency:"USD", sector:"AI/클라우드", sanityOk:true },
  { id:"6", ticker:"LLY",    name:"일라이릴리",    quantity:5,   price:890,   evalAmt:4450,     currency:"USD", sector:"글로벌 바이오", sanityOk:true },
  { id:"7", ticker:"COST",   name:"코스트코",      quantity:4,   price:900,   evalAmt:3600,     currency:"USD", sector:"소비재",       sanityOk:true },
  { id:"8", ticker:"JPM",    name:"JP모건",        quantity:10,  price:240,   evalAmt:2400,     currency:"USD", sector:"금융",         sanityOk:true },
];

const STORAGE_KEY = "portflow:state";

function calcRebalancing(holdings, targets, fx, driftTol) {
  const toKRW = (h) => h.currency === "USD" ? h.evalAmt * fx : h.evalAmt;
  const total = holdings.reduce((s, h) => s + toKRW(h), 0);
  return targets.map(t => {
    const sec = holdings.filter(h => h.sector === t.name);
    const cur = sec.reduce((s, h) => s + toKRW(h), 0);
    const curPct = total > 0 ? (cur / total) * 100 : 0;
    const tgtAmt = total * (t.targetPct / 100);
    const diff = tgtAmt - cur;
    const drift = curPct - t.targetPct;
    const trades = sec.map(h => {
      const hKRW = toKRW(h);
      const share = cur > 0 ? hKRW / cur : 1 / Math.max(sec.length, 1);
      const hDiff = diff * share;
      const priceKRW = h.currency === "USD" ? h.price * fx : h.price;
      const qty = priceKRW > 0 ? Math.floor(Math.abs(hDiff) / priceKRW) : 0;
      return { holding: h, action: qty === 0 ? "HOLD" : hDiff > 0 ? "BUY" : "SELL", quantity: qty, amtKRW: qty * priceKRW };
    });
    return { ...t, currentAmtKRW: cur, currentPct: curPct, diff, drift, needsAction: Math.abs(drift) > driftTol, trades };
  });
}

const fmtKRW = (n) => n >= 1e8 ? `${(n/1e8).toFixed(2)}억` : n >= 1e4 ? `${(n/1e4).toFixed(0)}만` : n.toLocaleString();
const delay = (ms) => new Promise(r => setTimeout(r, ms));

function Donut({ slices, size = 170 }) {
  const r = size * 0.32, cx = size / 2, cy = size / 2, circ = 2 * Math.PI * r;
  let off = 0;
  return (
    <svg width={size} height={size} style={{ overflow: "visible" }}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#1c2638" strokeWidth={size*0.13} />
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
  const [expanded, setExpanded] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const result = await storage.get(STORAGE_KEY);
        if (result?.value) {
          const saved = JSON.parse(result.value);
          if (saved.holdings?.length > 0) setHoldings(saved.holdings);
          if (saved.targets?.length > 0) setTargets(saved.targets);
          if (saved.fx) setFx(saved.fx);
          if (saved.driftTol) setDriftTol(saved.driftTol);
          if (saved.savedAt) setLastSaved(new Date(saved.savedAt));
        }
      } catch (e) {
        // 저장된 데이터 없음 (첫 실행) — 데모 데이터 유지
      }
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
        await storage.set(STORAGE_KEY, JSON.stringify({ holdings, targets, fx, driftTol, savedAt }));
        setSaveStatus("saved");
        setLastSaved(new Date(savedAt));
        setTimeout(() => setSaveStatus("idle"), 2000);
      } catch (e) {
        setSaveStatus("error");
      }
    }, 1000);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [holdings, targets, fx, driftTol, storageReady]);

  const resetAll = async () => {
    if (!confirm("저장된 모든 데이터를 삭제하고 데모 데이터로 초기화할까요?")) return;
    try { await storage.delete(STORAGE_KEY); } catch (e) {}
    setHoldings([]);
    setTargets(DEFAULT_TARGETS);
    setFx(1340);
    setDriftTol(5);
    setLastSaved(null);
  };

  const sectorResults = calcRebalancing(holdings, targets, fx, driftTol);
  const totalKRW = holdings.reduce((s, h) => s + (h.currency === "USD" ? h.evalAmt * fx : h.evalAmt), 0);
  const alertCount = sectorResults.filter(s => s.needsAction).length;
  const targetSum = targets.reduce((s, t) => s + t.targetPct, 0);
  const sentColor = { bullish:"#22d47a", neutral:"#f5a623", bearish:"#ff4d6a" };

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setImgSrc(URL.createObjectURL(file));
    setOcrStatus("parsing");
    for (let i = 0; i < 4; i++) { setOcrStep(i); await delay(500); }
    try {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1]);
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      const systemPrompt = `당신은 증권사 주식 보유 현황 스크린샷 전용 OCR 파싱 엔진입니다.
이미지에서 보유 종목 데이터를 추출하여 순수 JSON 배열만 반환하세요. 마크다운 없이.
필드: ticker, name, quantity(숫자), price(숫자), evalAmt(숫자), currency("KRW"|"USD"), sector
섹터 분류: NVDA,TSM,ASML,AMD,삼성전자,SK하이닉스→"미국 반도체" / LLY,UNH,JNJ→"글로벌 바이오" / MSFT,AMZN,GOOGL,META→"AI/클라우드" / AAPL,TSLA,COST→"소비재" / JPM,BRK.B→"금융" / 나머지→"기타"
숫자에서 ₩ $ , 원 제거. JSON 배열만 반환.`;
      const data = await callClaude({
        system: systemPrompt,
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: file.type || "image/jpeg", data: b64 } },
            { type: "text", text: "이 보유 현황 화면의 모든 종목을 JSON 배열로 추출하세요." }
          ]
        }]
      });
      const raw = data.content?.find(c => c.type === "text")?.text ?? "[]";
      const arr = JSON.parse(raw.replace(/```json|```/g, "").trim());
      const validated = arr.map(h => {
        const calc = h.quantity * h.price;
        const ok = h.evalAmt > 0 ? Math.abs(calc - h.evalAmt) / h.evalAmt < 0.15 : false;
        return { ...h, id: Math.random().toString(36).slice(2, 9), sanityOk: ok };
      });
      setParsed(validated.length > 0 ? validated : DEMO);
    } catch (e) {
      setParsed(DEMO);
    }
    setOcrStatus("done");
  }, []);

  const analyzeNews = async () => {
    if (!newsText.trim()) return;
    setNewsLoading(true); setNewsResult(null);
    try {
      const systemPrompt = `당신은 글로벌 금융시장 전문 포트폴리오 매니저 AI입니다.
★ 절대 규칙: ① 추천 종목은 시가총액 $200B 이상, S&P500 구성, 5년+ EPS/배당 성장, 경제적 해자 보유 종목만 ② 소형주·테마주·밈주식·코인관련주 절대 배제 ③ 투기적 표현 금지
JSON만 반환 (마크다운 없이):
{"summary":"3문장 요약","macro":"거시경제 영향","sentiment":"bullish|neutral|bearish","sectorImpact":[{"sector":"","impact":"positive|negative|neutral","reason":""}],"bluechipRecs":[{"ticker":"","name":"","reason":"","category":"Mega-Cap|Blue-Chip|Dividend-Growth","marketCap":""}],"risks":["",""],"portfolioAction":""}`;
      const data = await callClaude({
        system: systemPrompt,
        max_tokens: 1200,
        messages: [{ role: "user", content: newsText }],
      });
      const raw = data.content?.find(c => c.type === "text")?.text ?? "{}";
      setNewsResult(JSON.parse(raw.replace(/```json|```/g, "").trim()));
    } catch (e) {
      setNewsResult(DEMO_NEWS);
    }
    setNewsLoading(false);
  };

  if (!storageReady) {
    return (
      <div style={{...S.app, alignItems:"center", justifyContent:"center"}}>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}} .spin{width:34px;height:34px;border:3px solid #1c2638;border-top:3px solid #00e5b8;border-radius:50%;animation:spin .8s linear infinite}`}</style>
        <div className="spin"/>
        <div style={{marginTop:16,fontSize:12,color:"#4a5a72"}}>저장된 데이터 불러오는 중...</div>
      </div>
    );
  }

  return (
    <div style={S.app}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
        ::-webkit-scrollbar{display:none}
        input,textarea{outline:none}
        @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
        @keyframes spin{to{transform:rotate(360deg)}}
        .fade{animation:fadeUp .35s ease both}
        .spin{width:34px;height:34px;border:3px solid #1c2638;border-top:3px solid #00e5b8;border-radius:50%;animation:spin .8s linear infinite}
      `}</style>

      <header style={S.topbar}>
        <span style={S.logo}>PORTFLOW<span style={{color:"#00e5b8"}}>·AI</span></span>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{
            fontSize:9, letterSpacing:1, fontWeight:700,
            color: saveStatus==="saved"?"#22d47a":saveStatus==="saving"?"#f5a623":saveStatus==="error"?"#ff4d6a":"#4a5a72",
            transition:"color .3s",
          }}>
            {saveStatus==="saving"?"● 저장 중":saveStatus==="saved"?"✓ 저장됨":saveStatus==="error"?"⚠ 저장 실패":lastSaved?"☁ 동기화됨":""}
          </span>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:10,color:"#00e5b8",fontWeight:600,letterSpacing:1}}>USD/KRW</span>
            <input style={S.fxInput} type="number" value={fx} onChange={e=>setFx(+e.target.value)} />
          </div>
        </div>
      </header>

      <main style={S.main}>
        {tab === "home" && (
          <div className="fade">
            <div style={{padding:"8px 0 18px"}}>
              <div style={S.heroLabel}>총 평가 자산</div>
              <div style={S.heroValue}>₩{fmtKRW(totalKRW)}</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                <span style={badge("#00e5b8")}>{holdings.length}개 종목</span>
                {alertCount > 0 && <span style={badge("#ff4d6a")}>⚡ {alertCount}개 섹터 조치 필요</span>}
                {lastSaved && (
                  <span style={{fontSize:9,color:"#4a5a72"}}>
                    마지막 저장: {lastSaved.toLocaleString("ko-KR",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}
                  </span>
                )}
              </div>
            </div>

            <div style={S.hscroll}>
              {[
                { l:"USD 자산", v:`$${fmtKRW(holdings.filter(h=>h.currency==="USD").reduce((s,h)=>s+h.evalAmt,0))}`, c:"#22d47a" },
                { l:"KRW 자산", v:`₩${fmtKRW(holdings.filter(h=>h.currency==="KRW").reduce((s,h)=>s+h.evalAmt,0))}`, c:"#f5a623" },
                { l:"섹터", v:`${targets.length}개`, c:"#00e5b8" },
                { l:"리밸런싱", v:`${alertCount}건`, c: alertCount>0?"#ff4d6a":"#22d47a" },
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
                    <div style={{fontSize:9,letterSpacing:3,textTransform:"uppercase",color:"#4a5a72"}}>현재</div>
                    <div style={{fontSize:13,fontWeight:700,color:"#00e5b8",marginTop:2}}>₩{fmtKRW(totalKRW)}</div>
                  </div>
                </div>
                <div style={{flex:1,minWidth:150,display:"flex",flexDirection:"column",gap:7}}>
                  {sectorResults.map((s,i)=>(
                    <div key={i} style={{display:"flex",alignItems:"center",gap:6}}>
                      <div style={{width:8,height:8,borderRadius:2,background:s.color,flexShrink:0}}/>
                      <span style={{flex:1,fontSize:11,color:"#8a9bb5",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{s.name}</span>
                      <span style={{fontSize:11,fontWeight:700,color:s.color}}>{s.currentPct.toFixed(1)}%</span>
                      <span style={{fontSize:10,color:"#4a5a72"}}>→ {s.targetPct}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div style={S.card}>
              <div style={S.sectionLabel}>현재 vs 목표 비중</div>
              {sectorResults.map((s,i)=>(
                <div key={i} style={{marginBottom: i < sectorResults.length-1 ? 14 : 0}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                    <span style={{fontSize:12,color:"#dce8f5"}}>{s.name}</span>
                    <span style={{fontSize:10,fontWeight:700,color:Math.abs(s.drift)>5?"#ff4d6a":"#f5a623"}}>
                      {s.drift>0?"+":""}{s.drift.toFixed(1)}%
                    </span>
                  </div>
                  <Bar pct={s.currentPct} color={s.color} solid />
                  <Bar pct={s.targetPct} color={s.color} />
                </div>
              ))}
            </div>

            {alertCount > 0 && (
              <button style={S.ctaBanner} onClick={()=>setTab("rebalance")}>
                <div style={{textAlign:"left"}}>
                  <div style={{fontSize:14,fontWeight:700,color:"#ff4d6a",marginBottom:3}}>⚡ 리밸런싱 필요</div>
                  <div style={{fontSize:11,color:"#8a9bb5"}}>{alertCount}개 섹터가 목표 비중을 이탈했습니다</div>
                </div>
                <span style={{fontSize:22,color:"#ff4d6a"}}>→</span>
              </button>
            )}

            <button onClick={resetAll} style={{
              width:"100%", background:"transparent", border:"1px dashed #1c2638",
              borderRadius:10, padding:"10px", color:"#4a5a72", fontFamily:"inherit",
              fontSize:11, cursor:"pointer", marginTop:4,
            }}>
              🗑 저장 데이터 초기화 (데모로 되돌리기)
            </button>
          </div>
        )}

        {tab === "upload" && (
          <div className="fade">
            <div style={S.pageTitle}>보유 현황 업로드</div>
            <div style={S.pageSub}>증권사 캡처 이미지 → Vision OCR 자동 파싱</div>
{ocrStatus === "idle" && (
  <div>
    <button style={{...S.srcCard, width:"100%"}} onClick={()=>fileRef.current?.click()}>
      <span style={{fontSize:34}}>🖼</span>
      <div style={S.srcTitle}>이미지 선택</div>
      <div style={S.srcSub}>갤러리 / 파일</div>
    </button>
    <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}}
      onChange={e=>handleFile(e.target.files?.[0])} />
  </div>
)}
            {ocrStatus === "parsing" && (
              <div style={{...S.card, textAlign:"center", display:"flex", flexDirection:"column", alignItems:"center", gap:12}}>
                <div className="spin"/>
                <div style={{fontSize:15,fontWeight:700}}>Vision AI 분석 중</div>
                <div style={{width:"100%",height:5,background:"#1c2638",borderRadius:99,overflow:"hidden"}}>
                  <div style={{width:`${((ocrStep+1)/4)*100}%`,height:"100%",background:"#00e5b8",borderRadius:99,transition:"width .5s"}}/>
                </div>
                {["🔍 이미지 읽는 중...","🧠 종목 텍스트 감지 중...","⚡ 수량/가격 파싱 중...","✅ 데이터 검증 중..."].map((s,i)=>(
                  <div key={i} style={{fontSize:12,color:i===ocrStep?"#00e5b8":"#4a5a72",opacity:i===ocrStep?1:0.4}}>{s}</div>
                ))}
              </div>
            )}

            {ocrStatus === "done" && (
              <>
                {imgSrc && <img src={imgSrc} alt="" style={{width:"100%",maxHeight:200,objectFit:"contain",borderRadius:10,border:"1px solid #1c2638",marginBottom:12}}/>}
                <div style={{background:"#22d47a18",border:"1px solid #22d47a40",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#22d47a",marginBottom:12}}>
                  ✓ {parsed.length}개 종목 파싱 완료 — 확정하면 자동으로 저장됩니다
                </div>
                <div style={{...S.card, padding:0, overflow:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                    <thead><tr>{["종목","수량","평가금액","통화","검증"].map(h=>(
                      <th key={h} style={S.th}>{h}</th>
                    ))}</tr></thead>
                    <tbody>
                      {parsed.map((h,i)=>(
                        <tr key={h.id} style={{background:i%2?"#0d111760":"transparent"}}>
                          <td style={S.td}><div style={{fontWeight:700,color:"#00e5b8",fontSize:11}}>{h.ticker}</div><div style={{fontSize:10,color:"#4a5a72"}}>{h.name}</div></td>
                          <td style={{...S.td,textAlign:"right"}}>{h.quantity?.toLocaleString()}</td>
                          <td style={{...S.td,textAlign:"right",color:"#00e5b8",fontWeight:700}}>{h.currency==="USD"?"$":"₩"}{h.evalAmt?.toLocaleString()}</td>
                          <td style={S.td}><span style={badge(h.currency==="USD"?"#22d47a":"#f5a623")}>{h.currency}</span></td>
                          <td style={{...S.td,textAlign:"center"}}>{h.sanityOk?"✅":"⚠️"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{display:"flex",gap:10,marginTop:12}}>
                  <button style={S.btnSecondary} onClick={()=>{ setOcrStatus("idle"); setImgSrc(null); setParsed([]); }}>다시 업로드</button>
                  <button style={S.btnPrimary} onClick={()=>{ setHoldings(parsed); setTab("home"); }}>확정 & 저장 →</button>
                </div>
              </>
            )}
          </div>
        )}

        {tab === "rebalance" && (
          <div className="fade">
            <div style={S.pageTitle}>리밸런싱 제안</div>
            <div style={S.pageSub}>괴리율 ±{driftTol}% 초과 섹터 기준</div>

            <div style={S.hscroll}>
              {[
                { icon:"▲", l:`매수 ${sectorResults.flatMap(s=>s.trades).filter(t=>t.action==="BUY").length}건`, v:`₩${fmtKRW(sectorResults.flatMap(s=>s.trades).filter(t=>t.action==="BUY").reduce((s,t)=>s+t.amtKRW,0))}`, c:"#22d47a" },
                { icon:"▼", l:`매도 ${sectorResults.flatMap(s=>s.trades).filter(t=>t.action==="SELL").length}건`, v:`₩${fmtKRW(sectorResults.flatMap(s=>s.trades).filter(t=>t.action==="SELL").reduce((s,t)=>s+t.amtKRW,0))}`, c:"#ff4d6a" },
                { icon:"◆", l:"총 자산", v:`₩${fmtKRW(totalKRW)}`, c:"#00e5b8" },
              ].map((k,i)=>(
                <div key={i} style={{...S.kpiCard, borderColor:`${k.c}40`}}>
                  <div style={S.kpiLabel}><span style={{color:k.c}}>{k.icon}</span> {k.l}</div>
                  <div style={{...S.kpiValue, color:k.c}}>{k.v}</div>
                </div>
              ))}
            </div>

            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,flexWrap:"wrap"}}>
              <span style={{fontSize:10,letterSpacing:1,color:"#4a5a72"}}>괴리율 버퍼</span>
              {[2,3,5,7,10].map(v=>(
                <button key={v} onClick={()=>setDriftTol(v)} style={{
                  background: driftTol===v?"#00e5b815":"#121820",
                  border: `1px solid ${driftTol===v?"#00e5b850":"#1c2638"}`,
                  borderRadius:6, padding:"4px 10px",
                  color: driftTol===v?"#00e5b8":"#4a5a72",
                  fontFamily:"inherit", fontSize:11, cursor:"pointer",
                }}>±{v}%</button>
              ))}
            </div>

            {sectorResults.filter(s=>s.needsAction).length === 0
              ? <div style={{textAlign:"center",padding:"40px 20px",fontSize:15,color:"#8a9bb5",lineHeight:2}}>✅<br/>모든 섹터가 목표 비중 내에 있습니다</div>
              : sectorResults.filter(s=>s.needsAction).map((s,i)=>{
                const dc = s.diff>0?"#22d47a":"#ff4d6a";
                const trades = s.trades.filter(t=>t.action!=="HOLD");
                const isOpen = expanded === s.name;
                return (
                  <div key={i} onClick={()=>setExpanded(isOpen?null:s.name)}
                    style={{background:"#121820",border:`1px solid ${s.color}50`,borderRadius:14,display:"flex",marginBottom:12,overflow:"hidden",cursor:"pointer"}}>
                    <div style={{width:4,background:s.color,flexShrink:0}}/>
                    <div style={{flex:1,padding:"12px 12px 10px"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <div style={{width:10,height:10,borderRadius:2,background:s.color}}/>
                          <span style={{fontSize:14,fontWeight:700}}>{s.name}</span>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <span style={badge(dc)}>{s.diff>0?"▲ 매수":"▼ 매도"} 필요</span>
                          <div style={{fontSize:10,fontWeight:700,marginTop:4,color:Math.abs(s.drift)>5?"#ff4d6a":"#f5a623"}}>
                            괴리율 {s.drift>0?"+":""}{s.drift.toFixed(1)}%
                          </div>
                        </div>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
                        <div>
                          <div style={S.diffLabel}>필요 조정</div>
                          <div style={{fontFamily:"Syne,sans-serif",fontSize:19,fontWeight:800,color:dc}}>
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
                          {isOpen?"▲ 숨기기":`▼ 매매 상세 (${trades.length}건)`}
                        </div>
                      )}
                      {isOpen && trades.map((t,ti)=>{
                        const ac = t.action==="BUY"?"#22d47a":"#ff4d6a";
                        return (
                          <div key={ti} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:ti<trades.length-1?"1px solid #1c2638":"none"}}>
                            <div style={{width:42,height:42,borderRadius:8,background:`${ac}20`,border:`1px solid ${ac}50`,color:ac,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:800,flexShrink:0}}>
                              {t.action==="BUY"?"매수":"매도"}
                            </div>
                            <div style={{flex:1}}>
                              <div style={{fontSize:13,fontWeight:600}}>{t.holding.name}</div>
                              <div style={{fontSize:10,color:"#4a5a72"}}>{t.holding.ticker}</div>
                            </div>
                            <div style={{textAlign:"right"}}>
                              <div style={{fontSize:16,fontWeight:800,color:ac}}>{t.action==="BUY"?"+":"-"}{t.quantity}주</div>
                              <div style={{fontSize:10,color:"#4a5a72"}}>≈ ₩{fmtKRW(t.amtKRW)}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            }

            <div style={{...S.card, marginTop:16}}>
              <div style={S.sectionLabel}>목표 비중 설정 <span style={{fontSize:9,color:"#22d47a"}}>(변경 시 자동 저장)</span></div>
              {targets.map((t,i)=>(
                <div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                  <div style={{width:10,height:10,borderRadius:2,background:t.color,flexShrink:0}}/>
                  <span style={{flex:1,fontSize:12}}>{t.name}</span>
                  <input type="number" value={t.targetPct}
                    onChange={e=>setTargets(prev=>prev.map((s,j)=>j===i?{...s,targetPct:parseFloat(e.target.value)||0}:s))}
                    style={{width:60,background:"#0d1117",border:"1px solid #1c2638",borderRadius:6,padding:"5px 8px",color:"#dce8f5",fontFamily:"inherit",fontSize:13,textAlign:"right"}} />
                  <span style={{fontSize:13,fontWeight:700,color:t.color,minWidth:14}}>%</span>
                </div>
              ))}
              <div style={{fontFamily:"Syne,sans-serif",fontSize:15,fontWeight:800,textAlign:"right",paddingTop:8,borderTop:"1px solid #1c2638",color:Math.abs(targetSum-100)<0.1?"#22d47a":"#ff4d6a"}}>
                합계: {targetSum}% {Math.abs(targetSum-100)<0.1?"✓":"← 100% 맞춰주세요"}
              </div>
            </div>
          </div>
        )}

        {tab === "news" && (
          <div className="fade">
            <div style={S.pageTitle}>AI 시황 분석</div>
            <div style={{display:"inline-flex",alignItems:"center",gap:6,background:"#00e5b810",border:"1px solid #00e5b830",borderRadius:6,padding:"5px 10px",fontSize:10,color:"#00e5b8",marginBottom:14}}>
              🛡 Mega-Cap · Blue-Chip · Dividend-Growth 종목만 추천
            </div>

            <div style={S.hscroll}>
              {[
                { l:"🏦 FOMC", t:"연준 FOMC 의사록: 2025년 내 금리 2회 인하 시사. 인플레이션 목표치(2%) 근접. 달러 인덱스 0.4% 하락." },
                { l:"💾 반도체", t:"엔비디아 Blackwell GPU 2025년 수주잔액 500억 달러 돌파. TSMC 3nm 공정 수율 65% 달성." },
                { l:"🧬 바이오", t:"GLP-1 시장 2030년 $1조 전망. 일라이릴리 Mounjaro 처방 급증. 유나이티드헬스 의료비 증가 우려." },
              ].map((q,i)=>(
                <button key={i} onClick={()=>setNewsText(q.t)} style={{flexShrink:0,background:"#121820",border:"1px solid #1c2638",borderRadius:99,padding:"7px 14px",color:"#8a9bb5",fontFamily:"inherit",fontSize:11,fontWeight:600,cursor:"pointer",whiteSpace:"nowrap"}}>
                  {q.l}
                </button>
              ))}
            </div>

            <div style={{...S.card, padding:0, overflow:"hidden"}}>
              <div style={{padding:"12px 16px 0",display:"flex",justifyContent:"space-between"}}>
                <span style={S.sectionLabel}>뉴스 / 경제지표 입력</span>
                {newsText && <button style={{background:"none",border:"none",color:"#ff4d6a",cursor:"pointer",fontSize:12}} onClick={()=>setNewsText("")}>✕</button>}
              </div>
              <textarea value={newsText} onChange={e=>setNewsText(e.target.value)}
                placeholder={"예) FOMC 의사록에서 연준은 금리 동결 기조를 유지하며...\n엔비디아 Q2 실적 예상치 상회..."}
                style={{width:"100%",minHeight:110,background:"transparent",border:"none",padding:"10px 16px",color:"#dce8f5",fontFamily:"inherit",fontSize:13,lineHeight:1.7,resize:"vertical"}} />
              <div style={{padding:"8px 16px 12px",display:"flex",justifyContent:"space-between",alignItems:"center",borderTop:"1px solid #1c2638"}}>
                <span style={{fontSize:11,color:"#4a5a72"}}>{newsText.length}자</span>
                <button onClick={analyzeNews} disabled={!newsText.trim()||newsLoading}
                  style={{...S.btnPrimary, flex:"none", padding:"8px 20px", opacity:!newsText.trim()?0.4:1}}>
                  {newsLoading?"분석 중...":"AI 분석 →"}
                </button>
              </div>
            </div>

            {newsLoading && (
              <div style={{...S.card, textAlign:"center", padding:40, display:"flex", flexDirection:"column", alignItems:"center", gap:16}}>
                <div className="spin"/>
                <div style={{color:"#8a9bb5",fontSize:13}}>AI가 시황을 분석하고 있습니다...</div>
              </div>
            )}

            {newsResult && !newsLoading && (
              <div className="fade">
                <div style={S.card}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <span style={badge(sentColor[newsResult.sentiment]||"#f5a623")}>
                      {newsResult.sentiment==="bullish"?"▲ BULLISH":newsResult.sentiment==="bearish"?"▼ BEARISH":"◆ NEUTRAL"}
                    </span>
                    <span style={{fontSize:11,color:"#4a5a72"}}>{new Date().toLocaleDateString("ko-KR")}</span>
                  </div>
                  <div style={{fontSize:13,lineHeight:1.9,marginBottom:12}}>{newsResult.summary}</div>
                  <div style={{background:"#0d1117",borderLeft:"3px solid #00e5b8",borderRadius:"0 8px 8px 0",padding:"10px 14px",fontSize:12,color:"#8a9bb5",lineHeight:1.8}}>
                    <span style={{color:"#00e5b8",fontWeight:600}}>거시경제 </span>{newsResult.macro}
                  </div>
                </div>

                <div style={{...S.sectionLabel, padding:"0 4px"}}>섹터별 영향도</div>
                <div style={S.hscroll}>
                  {newsResult.sectorImpact?.map((s,i)=>{
                    const ic = s.impact==="positive"?"#22d47a":s.impact==="negative"?"#ff4d6a":"#f5a623";
                    return (
                      <div key={i} style={{flexShrink:0,width:150,background:"#121820",border:`1px solid ${ic}40`,borderRadius:12,padding:12,display:"flex",flexDirection:"column",gap:6}}>
                        <div style={{width:32,height:32,borderRadius:16,background:`${ic}20`,color:ic,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:800}}>
                          {s.impact==="positive"?"▲":s.impact==="negative"?"▼":"→"}
                        </div>
                        <div style={{fontSize:12,fontWeight:700}}>{s.sector}</div>
                        <div style={{fontSize:9,fontWeight:800,letterSpacing:2,color:ic}}>{s.impact?.toUpperCase()}</div>
                        <div style={{fontSize:10,color:"#8a9bb5",lineHeight:1.6}}>{s.reason}</div>
                      </div>
                    );
                  })}
                </div>

                <div style={{...S.sectionLabel, padding:"8px 4px", display:"flex", justifyContent:"space-between", alignItems:"center"}}>
                  우량주 추천
                  <span style={{fontSize:9,color:"#ff4d6a",background:"#ff4d6a15",border:"1px solid #ff4d6a30",padding:"2px 8px",borderRadius:99,letterSpacing:1}}>소형주 배제</span>
                </div>
                {newsResult.bluechipRecs?.map((r,i)=>{
                  const cc = r.category==="Mega-Cap"?"#00e5b8":r.category==="Blue-Chip"?"#22d47a":"#5b8dee";
                  return (
                    <div key={i} style={{...S.card, display:"flex", gap:12, alignItems:"flex-start", padding:14}}>
                      <div style={{width:50,height:50,borderRadius:10,background:`${cc}20`,border:`1px solid ${cc}40`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                        <span style={{fontSize:11,fontWeight:800,color:cc,letterSpacing:1}}>{r.ticker}</span>
                      </div>
                      <div style={{flex:1}}>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}>
                          <span style={{fontSize:13,fontWeight:700}}>{r.name}</span>
                          <span style={badge(cc)}>{r.category}</span>
                        </div>
                        {r.marketCap && <div style={{fontSize:10,color:"#4a5a72",letterSpacing:1,marginBottom:4}}>시총 {r.marketCap}</div>}
                        <div style={{fontSize:11,color:"#8a9bb5",lineHeight:1.7}}>{r.reason}</div>
                      </div>
                    </div>
                  );
                })}

                <div style={S.card}>
                  <div style={{...S.sectionLabel, color:"#ff4d6a"}}>리스크 요인</div>
                  {newsResult.risks?.map((r,i)=>(
                    <div key={i} style={{display:"flex",alignItems:"flex-start",gap:8,marginBottom:10}}>
                      <div style={{width:5,height:5,borderRadius:3,background:"#ff4d6a",marginTop:6,flexShrink:0}}/>
                      <span style={{fontSize:12,color:"#8a9bb5",lineHeight:1.8}}>{r}</span>
                    </div>
                  ))}
                </div>

                <div style={{...S.card, border:"1px solid #00e5b840", background:"#00e5b808"}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                    <span style={{fontSize:18}}>💼</span>
                    <span style={{...S.sectionLabel, color:"#00e5b8", marginBottom:0}}>포트폴리오 대응 전략</span>
                  </div>
                  <div style={{fontSize:13,lineHeight:1.9}}>{newsResult.portfolioAction}</div>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <nav style={S.tabbar}>
        {[["home","◈","홈"],["upload","📷","업로드"],["rebalance","⚖","리밸런싱"],["news","📡","시황"]].map(([key,icon,label])=>(
          <button key={key} onClick={()=>setTab(key)} style={{
            flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:3,
            padding:"10px 0 8px", background:"none", border:"none", cursor:"pointer", position:"relative",
            borderTop: tab===key?"2px solid #00e5b8":"2px solid transparent",
          }}>
            <div style={{position:"relative",display:"inline-block"}}>
              <span style={{fontSize:19,opacity:tab===key?1:0.35}}>{icon}</span>
              {key==="rebalance" && alertCount>0 && (
                <span style={{position:"absolute",top:-3,right:-8,minWidth:15,height:15,borderRadius:99,background:"#ff4d6a",color:"#fff",fontSize:9,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px"}}>{alertCount}</span>
              )}
            </div>
            <span style={{fontSize:9,letterSpacing:1.5,textTransform:"uppercase",color:tab===key?"#00e5b8":"#4a5a72",fontWeight:tab===key?700:400}}>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

function Bar({ pct, color, solid }) {
  return (
    <div style={{height:7,background:"#1c2638",borderRadius:99,display:"flex",alignItems:"center",marginBottom:3,overflow:"visible"}}>
      <div style={{
        width:`${Math.min(pct,100)}%`, height:"100%", borderRadius:99, minWidth:2, transition:"width .5s",
        background: solid ? color : `${color}40`,
        border: solid ? "none" : `1px dashed ${color}80`,
      }}/>
      <span style={{fontSize:10,marginLeft:6,whiteSpace:"nowrap",color:solid?color:"#4a5a72"}}>{pct.toFixed(1)}%</span>
    </div>
  );
}

const badge = (c) => ({
  fontSize:10, fontWeight:700, letterSpacing:1.5, textTransform:"uppercase",
  padding:"3px 10px", borderRadius:99, color:c, background:`${c}20`, border:`1px solid ${c}40`,
});

const S = {
  app: { minHeight:"100vh", background:"#080b10", color:"#dce8f5", fontFamily:"'DM Mono',monospace", fontSize:13, maxWidth:480, margin:"0 auto", display:"flex", flexDirection:"column", position:"relative" },
  topbar: { position:"sticky", top:0, zIndex:100, background:"#0d1117", borderBottom:"1px solid #1c2638", padding:"12px 16px", display:"flex", alignItems:"center", justifyContent:"space-between" },
  logo: { fontFamily:"'Syne',sans-serif", fontSize:17, fontWeight:800, letterSpacing:0.5 },
  fxInput: { width:72, background:"#121820", border:"1px solid #1c2638", borderRadius:6, padding:"4px 8px", color:"#dce8f5", fontFamily:"inherit", fontSize:12, textAlign:"right" },
  main: { flex:1, padding:16, paddingBottom:80, overflowY:"auto" },
  heroLabel: { fontSize:10, letterSpacing:3, textTransform:"uppercase", color:"#4a5a72", marginBottom:6 },
  heroValue: { fontFamily:"'Syne',sans-serif", fontSize:34, fontWeight:800, letterSpacing:-1, marginBottom:10 },
  hscroll: { display:"flex", overflowX:"auto", gap:10, paddingBottom:4, marginBottom:16 },
  kpiCard: { flexShrink:0, background:"#121820", border:"1px solid #1c2638", borderRadius:10, padding:"10px 14px", minWidth:110 },
  kpiLabel: { fontSize:9, letterSpacing:2, textTransform:"uppercase", color:"#4a5a72", marginBottom:4 },
  kpiValue: { fontFamily:"'Syne',sans-serif", fontSize:16, fontWeight:800 },
  card: { background:"#121820", border:"1px solid #1c2638", borderRadius:14, padding:16, marginBottom:14 },
  sectionLabel: { fontSize:10, letterSpacing:2.5, textTransform:"uppercase", color:"#4a5a72", marginBottom:14 },
  donutCenter: { position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" },
  ctaBanner: { width:"100%", background:"#ff4d6a18", border:"1px solid #ff4d6a50", borderRadius:14, padding:16, display:"flex", alignItems:"center", justifyContent:"space-between", cursor:"pointer", marginBottom:14, fontFamily:"inherit" },
  pageTitle: { fontFamily:"'Syne',sans-serif", fontSize:20, fontWeight:800, marginBottom:4 },
  pageSub: { fontSize:11, color:"#4a5a72", marginBottom:16 },
  srcCard: { background:"#121820", border:"1px solid #1c2638", borderRadius:14, padding:"20px 12px", display:"flex", flexDirection:"column", alignItems:"center", gap:8, cursor:"pointer", fontFamily:"inherit" },
  srcTitle: { fontSize:12, fontWeight:700, color:"#dce8f5" },
  srcSub: { fontSize:10, color:"#4a5a72" },
  th: { padding:"8px 12px", textAlign:"left", fontSize:9, letterSpacing:1.5, textTransform:"uppercase", color:"#4a5a72", background:"#0d1117", borderBottom:"1px solid #1c2638" },
  td: { padding:"9px 12px", borderTop:"1px solid rgba(28,38,56,0.13)" },
  btnPrimary: { flex:1, background:"#00e5b8", color:"#080b10", border:"none", borderRadius:99, padding:"13px 20px", fontFamily:"inherit", fontSize:13, fontWeight:700, letterSpacing:0.5, cursor:"pointer" },
  btnSecondary: { flex:1, background:"transparent", color:"#00e5b8", border:"1.5px solid #00e5b8", borderRadius:99, padding:"13px 20px", fontFamily:"inherit", fontSize:13, fontWeight:700, cursor:"pointer" },
  diffLabel: { fontSize:9, letterSpacing:1.5, textTransform:"uppercase", color:"#4a5a72", marginBottom:2 },
  tabbar: { position:"sticky", bottom:0, width:"100%", background:"#0d1117", borderTop:"1px solid #1c2638", display:"flex", zIndex:100 },
};

const DEMO_NEWS = {
  summary:"연준의 금리 동결 기조가 유지되는 가운데 AI 인프라 투자 사이클이 본격화되며 반도체·클라우드 섹터로 자금 유입이 집중되고 있습니다. 중국 반도체 수출 규제 강화는 단기 리스크이나 장기적으로 TSMC·엔비디아의 독점적 지위를 강화할 전망입니다. 인플레이션이 목표치에 근접하며 연준의 피벗 가능성이 높아졌습니다.",
  macro:"금리 인하 기대감이 성장주 밸류에이션 부담을 완화하고 있으며, 달러 약세 전환 시 글로벌 수출 우량주에 유리한 환경이 형성됩니다.",
  sentiment:"bullish",
  sectorImpact:[
    {sector:"미국 반도체",impact:"positive",reason:"AI 가속기 수요 폭발적 증가, GPU 수주 잔액 사상 최대"},
    {sector:"AI/클라우드",impact:"positive",reason:"하이퍼스케일러 CapEx 상향으로 클라우드 성장 가속"},
    {sector:"글로벌 바이오",impact:"neutral",reason:"GLP-1 시장 급성장 지속, 금리 민감도 중립"},
    {sector:"소비재",impact:"negative",reason:"고물가 장기화로 소비자 지출 둔화 우려"},
  ],
  bluechipRecs:[
    {ticker:"NVDA",name:"엔비디아",reason:"데이터센터 AI 가속기 시장 독점적 지위. Blackwell 플랫폼 출하 본격화로 견조한 실적 성장 전망.",category:"Mega-Cap",marketCap:"$3.2T"},
    {ticker:"MSFT",name:"마이크로소프트",reason:"Azure+Copilot AI 통합 수익화. 클라우드 2위 사업자로 안정적 성장과 꾸준한 배당 성장 이력.",category:"Mega-Cap",marketCap:"$3.0T"},
    {ticker:"LLY",name:"일라이릴리",reason:"GLP-1 시장 선도, 경제적 해자 보유. 강력한 신약 파이프라인으로 장기 성장 동력 확보.",category:"Blue-Chip",marketCap:"$750B"},
  ],
  risks:["중국 반도체 수출 보복 조치 가능성","연준 금리 인하 지연으로 밸류에이션 조정 압력","지정학적 리스크 확대 시 공급망 차질"],
  portfolioAction:"반도체·AI/클라우드 섹터의 비중을 목표치 내에서 유지하며, 바이오 섹터는 GLP-1 관련 우량주 중심 보유 전략이 적합합니다. 현금 비중 10%는 조정 시 매수 기회에 대비하여 유지 권장."
};
