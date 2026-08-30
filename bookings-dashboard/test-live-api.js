const USERNAME = "admin";
const PASSWORD = "admin123";

(async () => {
  const loginRes = await fetch("http://localhost:3003/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  console.log("Login status:", loginRes.status);
  const loginBody = await loginRes.json();
  console.log("Login response:", JSON.stringify(loginBody));

  const cookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get("set-cookie")];
  console.log("Cookies received:", cookies);
  const cookieHeader = cookies.map(c => c.split(";")[0]).join("; ");

  const res = await fetch("http://localhost:3003/api/occupancy?start=2026-08-01&end=2026-08-01", {
    headers: { Cookie: cookieHeader },
  });
  console.log("\nOccupancy status:", res.status);
  const text = await res.text();
  console.log("Occupancy raw response:");
  console.log(text);
})();
