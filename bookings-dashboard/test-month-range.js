const USERNAME = "admin";
const PASSWORD = "admin123";

(async () => {
  const loginRes = await fetch("http://localhost:3003/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const cookies = loginRes.headers.getSetCookie();
  const cookieHeader = cookies.map(c => c.split(";")[0]).join("; ");

  // Same range loadCalendar() uses for August 2026
  const res = await fetch("http://localhost:3003/api/occupancy?start=2026-08-01&end=2026-08-31", {
    headers: { Cookie: cookieHeader },
  });
  const data = await res.json();

  console.log("Days returned:", data.days.length);
  data.days.slice(0, 8).forEach(d => {
    console.log(`  date="${d.date}" total=${d.total} BK=${d.byPlatform['booking.com']} AB=${d.byPlatform.airbnb}`);
  });
})();
