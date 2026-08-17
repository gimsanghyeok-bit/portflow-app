// Vercel Serverless Function — 실시간 국내 주가 조회 프록시
// 네이버 금융의 공개(비공식) 시세 API를 대신 호출해서 CORS 문제 없이 씁니다.
// 인증/키 필요 없음. 종목코드 쉼표로 여러 개 한번에 조회 가능.
// 예: /api/quote?codes=005930,000660,012450

export default async function handler(req, res) {
  const { codes } = req.query;
  if (!codes) {
    return res.status(400).json({ error: "codes query parameter required" });
  }

  try {
    const resp = await fetch(
      `https://polling.finance.naver.com/api/realtime/domestic/stock/${codes}`
    );
    if (!resp.ok) {
      return res.status(resp.status).json({ error: "upstream error" });
    }
    const data = await resp.json();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
