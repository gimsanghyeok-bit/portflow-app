// Vercel Routing Middleware — 사이트 전체(정적 페이지 + /api 포함)에 로그인 보호를 겁니다.
// 브라우저 팝업(Basic Auth) 대신 직접 만든 로그인 페이지(/login.html)를 씁니다.
// 카카오톡 인앱 브라우저 등에서도 안정적으로 동작합니다.
// Vercel 프로젝트 설정 > Environment Variables 에 SITE_USER, SITE_PASSWORD 를 등록하세요.

export default function middleware(request) {
  const url = new URL(request.url);

  // 로그인 페이지와 로그인 처리 API는 항상 통과
  if (url.pathname === "/login.html" || url.pathname === "/api/login") {
    return;
  }

  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/site_auth=([^;]+)/);
  const value = match ? decodeURIComponent(match[1]) : null;
  const envUser = (process.env.SITE_USER || "").trim();
  const envPass = (process.env.SITE_PASSWORD || "").trim();
  const expected = `${envUser}:${envPass}`;

  if (value === expected) {
    return; // 통과
  }

  return Response.redirect(new URL("/login.html", request.url), 302);
}
