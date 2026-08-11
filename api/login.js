// 로그인 처리: 아이디/비밀번호가 맞으면 쿠키를 심고 홈으로 리다이렉트.
// 이 쿠키는 middleware.js가 확인합니다.

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  // req.body가 자동 파싱 안 된 경우를 대비해 직접 읽어서 폼 데이터를 파싱
  let user = req.body?.user;
  let password = req.body?.password;
  if (user === undefined || password === undefined) {
    const raw = await readBody(req);
    const params = new URLSearchParams(raw);
    user = params.get("user") || "";
    password = params.get("password") || "";
  }

  const envUser = (process.env.SITE_USER || "").trim();
  const envPass = (process.env.SITE_PASSWORD || "").trim();

  if (user.trim() === envUser && password === envPass) {
    const token = encodeURIComponent(`${envUser}:${envPass}`);
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
