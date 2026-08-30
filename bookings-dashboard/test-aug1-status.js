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

  const res = await fetch("http://localhost:3003/api/occupancy?start=2026-08-01&end=2026-08-01", {
    headers: { Cookie: cookieHeader },
  });
  const data = await res.json();
  const day = data.days[0];
  console.log("Date:", day.date, "| Total:", day.total);
  day.bookings.forEach(b => {
    console.log(`  ${b.guest_name} | ${b.check_in} -> ${b.check_out} | stay_status="${b.stay_status}"`);
  });
})();
