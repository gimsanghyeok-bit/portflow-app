// 로그인 처리: 아이디/비밀번호가 맞으면 쿠키를 심고 홈으로 리다이렉트.
// 이 쿠키는 middleware.js가 확인합니다.

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const { user, password } = req.body || {};

  if (user === process.env.SITE_USER && password === process.env.SITE_PASSWORD) {
    const token = encodeURIComponent(`${process.env.SITE_USER}:${process.env.SITE_PASSWORD}`);
    res.setHeader(
      "Set-Cookie",
      `site_auth=${token}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`
    );
    res.writeHead(302, { Location: "/" });
    return res.end();
  }

  res.writeHead(302, { Location: "/login.html?error=1" });
  res.end();
}
