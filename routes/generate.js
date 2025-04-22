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

// SM-2 logic with 3 buttons
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
You are an expert educator. From the input text below, generate flashcards in Thai using Bloom’s Taxonomy.
For each flashcard, decide **if a visual (photo, diagram, or icon) would significantly boost understanding**.
 
Output **only** this JSON array—no commentary:

[
  {
    "question": "...",
    "answer": "...",
    "keyword": "...",
    "needs_image": true   // or false
  },
  …
]

Rules for keyword:
• 1-3 English words or short phrase (e.g. “photosynthesis diagram”) for searching images. The the keywords you use has to be able to serach for significant to the answer of the question make sure the user or visual learners will be able to learn as good as possible like diagrams, etc. I want you to think of visual learners and their needs for the serach keyword.
• If needs_image is false, keyword can be empty or omitted.

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
    const raw = JSON.parse(response.choices[0].message.content);

    const cards = await Promise.all(
      raw.map(async (c) => {
        const kw   = c.needs_image ? c.keyword : '';
        const img  = c.needs_image ? await fetchImage(kw) : null;
        return {
          id:        uuid(),
          question:  c.question,
          answer:    c.answer,
          keyword:   kw,
          needs_image: c.needs_image,
          image:     img,
          point:     0,
          repetitions:0,
          interval:  0,
          ef:        2.5,
          due:       today
        };
      })
    );

    const decks = loadDecks();
    const newDeck = {
      id: uuid(),
      name: req.body.deckName || req.file.originalname.replace(/\.pdf$/i, ''),
      description: `Generated from ${req.file.originalname}`,
      studied: false,
      total: cards.length,
      learned: 0,
      due: cards.length,
      cards
    };

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
1. Analyze the flashcard’s question and answer.
2. Then, write a concise explanation in **Thai** that helps a student understand **why** the answer is correct and what the underlying concept means.
3. Use simple but precise language suitable for educational purposes.
4. Avoid repeating the answer—focus on expanding the understanding.

Flashcard Question: ${question}  
Flashcard Answer: ${answer}  

Output the explanation in Thai.
    `;

    // Call the Together API with your prompt
    const response = await together.chat.completions.create({
      model: 'scb10x/scb10x-llama3-1-typhoon2-70b-instruct',
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


module.exports = router;
