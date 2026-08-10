// Vercel Routing Middleware — 사이트 전체(정적 페이지 + /api 포함)에 비밀번호를 겁니다.
// 완전 무료(Hobby 요금제)로 동작합니다.
// Vercel 프로젝트 설정 > Environment Variables 에 SITE_USER, SITE_PASSWORD 를 등록하세요.

export default function middleware(request) {
  const auth = request.headers.get("authorization");

  if (auth) {
    const [scheme, encoded] = auth.split(" ");
    if (scheme === "Basic" && encoded) {
      const decoded = atob(encoded);
      const idx = decoded.indexOf(":");
      const user = decoded.slice(0, idx);
      const pass = decoded.slice(idx + 1);
      if (user === process.env.SITE_USER && pass === process.env.SITE_PASSWORD) {
        return; // 통과
      }
    }
  }

  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="PortFlow AI"' },
  });
}