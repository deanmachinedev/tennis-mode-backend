import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// Health check (Render requires this)
app.get("/", (req, res) => {
  res.send("Tennis Mode backend running");
});

// ATP live scores endpoint
app.get("/api/atp", async (req, res) => {
  try {
    const response = await fetch(
      "https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard"
    );

    if (!response.ok) {
      return res.status(500).json({ error: "ESPN fetch failed" });
    }

    const data = await response.json();

    const events = data?.events || [];

    const matches = events.slice(0, 5).map((event) => {
      const comp = event.competitions?.[0];
      const players = comp?.competitors || [];

      return {
        tournament: event?.name,
        playerA: players?.[0]?.athlete?.displayName || "Player A",
        playerB: players?.[1]?.athlete?.displayName || "Player B",
        scoreA: players?.[0]?.score || "0",
        scoreB: players?.[1]?.score || "0",
        status: comp?.status?.type?.description || "Scheduled"
      };
    });

    res.json({ matches });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
