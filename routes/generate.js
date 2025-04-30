const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const { v4: uuid } = require('uuid');
const Together = require('together-ai');
const fetchImage = require('../routes/fetchImage.js');

const router = express.Router();
const together = new Together({ apiKey: process.env.TOGETHER_API_KEY });

const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({ dest: uploadDir });

// path to decks.json in your React app
const JSON_PATH = path.resolve(__dirname, '../decks.json');
const loadDecks = () => JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const saveDecks = (data) => fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2));

const todayIso = () => new Date().toISOString().slice(0, 10);

// SM-2 logic with 3 button
function sm2(card, quality) {
  if (quality < 3) {
    card.repetitions = 0;
    card.interval = 1;
  } else {
    if (card.repetitions === 0) card.interval = 1;
    else if (card.repetitions === 1) card.interval = 6;
    else card.interval = Math.round(card.interval * card.ef);

    card.repetitions += 1;
    card.ef = Math.max(
      1.3,
      card.ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
    );
  }

  card.due = new Date(Date.now() + card.interval * 86400000)
    .toISOString()
    .slice(0, 10);

  return card;
}

router.post('/generate-deck', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) throw new Error('No PDF uploaded');

    const buffer = fs.readFileSync(req.file.path);
    const { text } = await pdf(buffer);

    const prompt = `
You are an expert educator. From the input text below, generate flashcards in Thai using Bloom's Taxonomy.
For each flashcard, decide **if a visual (photo, diagram, or icon) would significantly boost understanding or that will allow the user to be able to visualize the concept in their heads** the goal is for the user to be able to visualize the answer aswell or understand the answer by image.
 
- Generate a very short deck title (1-3 words) prefixed by an appropriate emoji.
- Generate a one-sentence description of the deck (in Thai, aside from any English terms).

Output **only** this JSON array—no commentary:

{
  "title": "emoji prefix ตามด้วยชื่อสั้นๆ",
  "description": "คำอธิบายสั้นๆ ในภาษาไทย",
  "cards": [
    { "question": "...", 
     "answer": "...", 
     "keyword": "...", 
     "needs_image": true // or false
     },
    ...
  ]
}

Rules for keyword:
- 1-3 English words or short phrase (e.g. “photosynthesis diagram”) for searching images. The the keywords you use has to be able to serach for a good representation answer of the question make sure the user or visual learners will be able to learn as good as possible like diagrams, etc. I want you to think of visual learners and their needs for the serach keyword.
- If you decided that needs_image is false, keyword can be empty or omitted.

Steps:
1) Generate “Remembering” cards (factual Q&A).  
2) Generate “Understanding” cards (conceptual Q&A).  
3) For each, set needs_image to true **only** when a visual cue clearly maps to the concept.  
4) Provide keyword only when needs_image=true.

--- BEGIN TEXT ---
${text}
--- END TEXT ---
`;

    const response = await together.chat.completions.create({
      model: 'scb10x/scb10x-llama3-1-typhoon2-70b-instruct',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096
    });

    let cardsRaw;
    try {
      cardsRaw = JSON.parse(response.choices[0].message.content);
    } catch (e) {
      console.error('Invalid model response:', response.choices[0].message.content);
      throw new Error('Model did not return valid JSON');
    }

    const today = new Date().toISOString().slice(0, 10);
    let deckRaw;
      try {
        deckRaw = JSON.parse(response.choices[0].message.content);
      } catch(e) {
        console.error('Invalid model response:', response.choices[0].message.content);
        throw new Error('Model did not return valid JSON');
      }

    const cards = await Promise.all(
      deckRaw.cards.map(async (c) => {
        const img = c.needs_image
          ? await fetchImage(c.keyword)
          : null;
        return {
          id:         uuid(),
          question:   c.question,
          answer:     c.answer,
          keyword:    c.keyword,
          needs_image:c.needs_image,
          image:      img,
          point:      0,
          repetitions:0,
          interval:   0,
          ef:         2.5,
          due:        today
        };
      })
    );

    const decks = loadDecks();
    const newDeck = {
      id:          uuid(),
      name:        deckRaw.title,
      description: deckRaw.description,
      studied:     false,
      total:       cards.length,
      learned:     0,
      due:         cards.length,
      cards
    };

     // → Generate the stylized summary *once* at creation
    const summaryPrompt = `You are an expert educational writer and copyeditor, writing in clear, engaging Thai (except that any domain-specific English words or acronyms must be kept in English).

Your task is to read the full text of the PDF (inserted below) and produce a **1-5 minute** study summary, the output must be a self-contained chunk of **semantic** HTML (no inline styles) that uses:

- an '<h1>' for the main title  
- '<h2>' for each major section  
- '<p>' for ordinary paragraphs  
- '<ul><li>' lists for bullet points  
- '<strong>' to highlight key terms (especially flashcard keywords)  
- '<em>' for any side notes or emphasis  

**Do not** output any plain-text lists or Markdown.  **Do not** wrap your HTML in '<html>'/'<body>'—just the snippet.  **Do not** return any commentary or “explanatory” lines.

It should be fully stylized and focused on readability with html styling. Return something along the lines of:

<h1>...</h1><p>...<strong>...</strong></p><h2>...</h2><ul><li>...</li>...</ul>...

But feel free to choose the styling that you think fits the topic and readability best.
Ensure the entire summary is in Thai (aside from any necessary English technical terms or acronyms), and keep each section concise and scannable.

BEGIN RAW TEXT
${text}
END RAW TEXT
`;

    const sumResp = await together.chat.completions.create({
      model: 'scb10x/scb10x-llama3-1-typhoon2-8b-instruct',
      messages: [{ role: 'user', content: summaryPrompt }],
      max_tokens: 1500
    });
    newDeck.summaryHtml = sumResp.choices[0].message.content.trim();

    decks.push(newDeck);
    saveDecks(decks);

    fs.unlink(req.file.path, () => {}); // clean temp file
    res.json(newDeck);
  } catch (err) {
    console.error('generate-deck error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/explanation', async (req, res) => {
  try {
    const { question, answer } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ error: "Missing question or answer." });
    }

    // Build a prompt for the AI explanation
    const prompt = `
You are an expert educator that speaks Thai. Your task is to provide a **clear and insightful explanation in Thai** to help students deeply understand the concept behind the flashcard below.

Instructions:
1. Analyze the flashcard's question and answer.
2. Then, write a concise explanation in **Thai** that helps a student understand **why** the answer is correct and what the underlying concept means.
3. Use simple but precise language suitable for educational purposes.
4. Avoid repeating the answer—focus on expanding the understanding.

Flashcard Question: ${question}  
Flashcard Answer: ${answer}  

Output the explanation in Thai.
    `;

    // Call the Together API with your prompt
    const response = await together.chat.completions.create({
      model: 'scb10x/scb10x-llama3-1-typhoon2-8b-instruct',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
    });

    // Extract and clean up the explanation text
    const explanation = response.choices[0].message.content.trim();
    res.json({ explanation });
  } catch (err) {
    console.error('AI explanation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/summarize-deck/:id
router.get('/summarize-deck/:id', (req, res) => {
  const decks = loadDecks();
  const deck  = decks.find(d => d.id === req.params.id);
  if (!deck)  return res.status(404).json({ error: 'Deck not found' });
  return res.json({ summaryHtml: deck.summaryHtml || '' });
});

// helper: seed SM-2 fields + optional image
async function hydrateCard(c) {
  const img = c.needs_image ? await fetchImage(c.keyword) : null;
  return {
    id: uuid(),
    question: c.question,
    answer:   c.answer,
    keyword:  c.keyword,
    needs_image: c.needs_image,
    image:    img,
    point: 0,
    repetitions: 0,
    interval: 0,
    ef: 2.5,
    due: todayIso(),
  };
}

router.post('/related-cards', async (req, res) => {
  try {
    const { question, answer } = req.body;
    if (!question || !answer)
      return res.status(400).json({ error: 'Missing question or answer' });

    /* ---------- 1. Ask the LLM for extra cards ---------- */
    const prompt = `
คุณเป็นครูผู้เชี่ยวชาญ จงสร้าง flashcard ภาษาไทยแบบสั้น ๆ เพิ่ม 4-6 ใบ
เพื่อขยายแนวคิดเดียวกับ flashcard ด้านล่าง (Remember / Understand / Apply)
คืนค่าเป็น JSON array ของวัตถุ
{question, answer, keyword, needs_image}

flashcard ต้นฉบับ:
Q: ${question}
A: ${answer}`.trim();

    const resp = await together.chat.completions.create({
      model: 'scb10x/scb10x-llama3-1-typhoon2-8b-instruct',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1200,
    });

    let raw;
    try { raw = JSON.parse(resp.choices[0].message.content); }
    catch { throw new Error('LLM did not return valid JSON'); }

    /* ---------- 2. Enrich each card ---------- */
    const cards = await Promise.all(raw.map(hydrateCard));

    res.json({ cards });
  } catch (err) {
    console.error('related-cards error:', err);
    res.status(500).json({ error: err.message });
  }
});



module.exports = router;
