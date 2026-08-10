// Vercel Serverless Function
// 실제 Anthropic API 키는 여기(서버)에서만 사용되고, 브라우저에는 절대 노출되지 않습니다.
// Vercel 프로젝트 설정 > Environment Variables 에 ANTHROPIC_API_KEY 를 등록하세요.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on server" });
  }

  const { system, messages, max_tokens, tools } = req.body;

  try {
    const body = {
      model: "claude-sonnet-4-6",
      max_tokens: max_tokens || 1000,
      system,
      messages,
    };
    if (tools) body.tools = tools;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}