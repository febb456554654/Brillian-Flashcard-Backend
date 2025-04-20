const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const { v4: uuid } = require('uuid');
const Together = require('together-ai');
const fsPromises = require('fs').promises;
const cors = require('cors');  // CORS package

const router = express.Router();
const together = new Together({ apiKey: process.env.TOGETHER_API_KEY });

const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({ dest: uploadDir });

const JSON_PATH = path.resolve(__dirname, '../decks.json');

// Enable CORS for all routes
router.use(cors({
  origin: 'https://brillian-flashcards.web.app',  // Replace with your frontend's URL
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Async load and save functions for better performance
const loadDecks = async () => {
  try {
    // Check if the file exists
    if (!fs.existsSync(JSON_PATH)) {
      console.error("decks.json does not exist. Creating an empty file.");
      // Create an empty JSON file if it doesn't exist
      await fsPromises.writeFile(JSON_PATH, '[]');
      return []; // Return an empty array
    }

    const data = await fsPromises.readFile(JSON_PATH, 'utf8');
    const parsed = JSON.parse(data);

    // Ensure parsed data is an array, otherwise default to empty array
    if (Array.isArray(parsed)) {
      return parsed;
    } else {
      console.error("Invalid decks format in JSON, defaulting to empty array.");
      return [];  // Return an empty array if the format is invalid
    }
  } catch (error) {
    console.error("Error loading decks.json:", error);
    return []; // Return an empty array if there's an error reading the file
  }
};

const saveDecks = async (data) => {
  try {
    await fsPromises.writeFile(JSON_PATH, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Error saving decks:", error);
  }
};

// Route to generate flashcards
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
      point: 0,  // Initialize the point field to 0
      repetitions: 0,
      interval: 0,
      ef: 2.5,
      due: today
    }));

    const decks = await loadDecks();

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

      decks.push(newDeck);
      await saveDecks(decks);

      fs.unlink(req.file.path, (err) => {
        if (err) {
          console.error('Error deleting temp file:', err);
        }
      });

      res.json(newDeck);
    } else {
      throw new Error("Failed to load decks: decks is not an array.");
    }
  } catch (err) {
    console.error('generate-deck error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Route to generate explanation for flashcards (with the explanation generation logic)
router.post('/explanation', async (req, res) => {
  try {
    const { question, answer } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ error: "Missing question or answer." });
    }

    // Build a prompt for the AI explanation
    const prompt = `
You are an expert educator. Please provide an explanation for the following flashcard to help students understand the concept better.

Flashcard Question: ${question}
Flashcard Answer: ${answer}

Provide a clear and succinct explanation.
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
