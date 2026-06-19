require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { SYSTEM_PROMPT } = require("./prompt");

const app = express();
app.use(express.json());

// Allow requests from the extension (chrome-extension://*) and localhost for dev
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || /^chrome-extension:\/\//.test(origin) || /^https?:\/\/localhost/.test(origin)) {
        cb(null, true);
      } else {
        cb(new Error("Not allowed by CORS"));
      }
    },
  })
);

app.post("/buzzwordify", async (req, res) => {
  const { text } = req.body ?? {};
  if (!text || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text.trim() }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error("Anthropic error:", err);
    return res.status(502).json({ error: "upstream API error" });
  }

  const data = await response.json();
  const result = data.content[0].text;
  res.json({ result });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`buzzwordify backend listening on :${PORT}`));
