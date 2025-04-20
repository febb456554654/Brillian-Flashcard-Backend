const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const pdf = require('pdf-parse');
const { v4: uuid } = require('uuid');
const Together = require('together-ai');
const cors = require('cors');  // Import the CORS package

// Initialize express
const app = express();

// Enable CORS for all routes (you can restrict it to specific origins if needed)
app.use(cors({
  origin: 'https://brillian-flashcards.web.app',  // Replace with your frontend URL
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const router = express.Router();
const together = new Together({ apiKey: process.env.TOGETHER_API_KEY });

const uploadDir = path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({ dest: uploadDir });

// path to decks.json in your React app
const JSON_PATH = path.resolve(__dirname, '../decks.json');
const loadDecks = () => {
  try {
    if (!fs.existsSync(JSON_PATH)) {
      console.error("decks.json does not exist. Creating an empty file.");
      // Create an empty JSON file if it doesn't exist
      fs.writeFileSync(JSON_PATH, '[]');
      return []; // Return an empty array
    }

    const data = fs.readFileSync(JSON_PATH, 'utf8');
    console.log('decks.json content:', data);  // Log the content of the file

    const parsed = JSON.parse(data);

    // Ensure the parsed data is an array, otherwise default to empty array
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

const saveDecks = (data) => {
  try {
    fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Error saving decks:", error);
  }
};


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

app.use('/api', router);

app.listen(5000, () => {
  console.log('Server is running on port 5000');
});

router.post('/explanation', async (req, res) => {
  try {
    const { question, answer } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ error: "Missing question or answer." });
    }

    // Build a prompt for the AI explanation
    const prompt = `
You are an expert educator. Please provide an explanation for the following flashcard to help students understand the concept better in Thai.

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
