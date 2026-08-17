// Vercel Serverless Function — Google Gemini API 프록시 (무료 등급)
// 실제 Gemini API 키는 여기(서버)에서만 사용되고, 브라우저에는 노출되지 않습니다.
// Vercel 프로젝트 설정 > Environment Variables 에 GEMINI_API_KEY 를 등록하세요.
// 키 발급: https://aistudio.google.com/apikey (무료, 카드 등록 불필요)

const MODEL = "gemini-3.5-flash";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "GEMINI_API_KEY not configured on server" });
  }

  const { contents, systemInstruction, maxOutputTokens, useSearch } = req.body;

  try {
    const body = {
      contents,
      generationConfig: {
        maxOutputTokens: maxOutputTokens || 2000,
      },
    };
    if (systemInstruction) {
      body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    if (useSearch) {
      // 웹 검색(그라운딩) 도구 — Gemini가 직접 검색해서 답변에 반영
      body.tools = [{ google_search: {} }];
    }

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
      }
    );

    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
