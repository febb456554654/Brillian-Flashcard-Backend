const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const { v4: uuid } = require('uuid');
const Together = require('together-ai');

const router = express.Router();
const together = new Together({ apiKey: process.env.TOGETHER_API_KEY });

const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({ dest: uploadDir });

// path to decks.json in your React app
const JSON_PATH = path.resolve(__dirname, '../decks.json');
const loadDecks = () => {
  try {
    const data = fs.readFileSync(JSON_PATH, 'utf8');
    const parsed = JSON.parse(data);
    // Ensure parsed data is an array
    if (Array.isArray(parsed)) {
      return parsed;
    } else {
      console.error("Invalid decks format in JSON, defaulting to empty array.");
      return [];
    }
  } catch (error) {
    console.error("Error loading decks.json:", error);
    return []; // Return an empty array if there's an error
  }
};

const saveDecks = (data) => {
  try {
    fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Error saving decks:", error);
  }
};

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
You are an expert educator that speaks Thai. Your task is to create flashcards in **Thai only**, using Bloom’s Taxonomy to ensure full conceptual coverage of the input material.

Follow these specific instructions:
1. Use Bloom’s Taxonomy to generate two levels of flashcards:
   - First, create **“Remembering” level** flashcards: factual, straightforward Q&A to test memory and recall.
   - Then, create **“Understanding” level** flashcards: deeper, more comprehensive Q&A that test conceptual understanding and interpretation.
2. Ensure all core concepts from the input material are covered fully.
3. Output ONLY in the following strict JSON format:
[ { "question": "...", "answer": "..." }, ... ]

Important: All questions and answers must be written in **Thai** but English if fine for 'English' specific words.

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
    const cards = cardsRaw.map((c) => ({
      id: uuid(),
      question: c.question,
      answer: c.answer,
      repetitions: 0,
      interval: 0,
      ef: 2.5,
      due: today
    }));

    const decks = loadDecks();
    
    // Ensure that decks is always an array before pushing
    if (Array.isArray(decks)) {
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

      decks.push(newDeck);  // Now safely push new deck to decks
      saveDecks(decks);      // Save the updated decks to the file

      fs.unlink(req.file.path, () => {}); // clean temp file
      res.json(newDeck);  // Send the new deck as response
    } else {
      throw new Error("Failed to load decks: decks is not an array.");
    }
  } catch (err) {
    console.error('generate-deck error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
