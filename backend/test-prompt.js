require("dotenv").config();
const { SYSTEM_PROMPT } = require("./prompt");

const SAMPLES = [
  // single nouns
  "bread",
  "meeting",
  "dog",
  // short phrases
  "I'm tired",
  "it's raining",
  // full sentences
  "The coffee is ready.",
  "Can we reschedule the call for tomorrow?",
  // Slack-style messages
  "hey, circling back on the thing we discussed",
  "just wanted to loop you in",
  // recipe step
  "Add two cups of flour and stir until smooth.",
];

async function buzzwordify(text) {
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
      messages: [{ role: "user", content: text }],
    }),
  });

  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  return data.content[0].text;
}

async function main() {
  console.log("=== Buzzwordify Prompt Test ===\n");

  for (const sample of SAMPLES) {
    process.stdout.write(`INPUT:  ${sample}\n`);
    try {
      const result = await buzzwordify(sample);
      console.log(`OUTPUT: ${result}`);
    } catch (err) {
      console.error(`ERROR:  ${err.message}`);
    }
    console.log("-".repeat(70));
  }
}

main();
