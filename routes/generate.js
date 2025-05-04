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

    const prompt = `You are an expert educator specializing in creating effective learning materials. From the input text below, generate a set of flashcards in Thai (English is fine for English-specific words or vocabulary like vocabulary worksheets) using Bloom's Taxonomy.
For each flashcard, classify it into one of the following categories:
- Remembering: Recall facts, terms, and definitions.
- Understanding: Comprehend, explain, or interpret concepts.
- Applying: Apply knowledge in practical, real-world scenarios.

Key Guidelines:
- Visuals: For each flashcard, evaluate whether a visual (photo, diagram, illustration, or icon) would significantly enhance comprehension and memorability.
- If a visual is needed, choose a 1-3 word keyword that would work well for an image search to help the user visualize the concept or answer. Prioritize keywords that yield diagrams, labeled illustrations, or clear visual representations.
- If no visual is needed, omit the keyword or leave it blank.
- Deck Title: Generate a short title (1-3 words) prefixed by an appropriate emoji.
- Deck Description: Provide a concise one-sentence description of the deck in Thai. Use English terms only when necessary.

Output Format: Your output must **only** be a raw JSON array with the following structure, and no additional text or markdown with no formatting tags:

{
  "title": "emoji_prefix ชื่อสั้นๆ",
  "description": "คำอธิบายสั้นๆ ภาษาไทย",
  "cards": [
    {
      "question": "...",
      "answer": "...",
      "keyword": "...",
      "needs_image": false // or true,
      "taxonomy": "Remembering"  // (Choose: "Remembering", "Understanding", "Applying")
    },
    ...
  ]
}

Process:
- Remembering: Generate cards that test factual recall (e.g., terms, definitions).
- Understanding: Generate cards that test comprehension (e.g., explanations, interpretations).
- Applying: Generate cards that test the ability to apply knowledge in real-world scenarios. Include a practical example or problem to solve.

The number of flashcards of each type will vary from the material (eg., An English vocabulary worksheet would have many more remembering cards than understanding or Applying, Or subjects like Biology that requires more of remembering and understanding)
**Create as many flashcards as needed to cover the full material.**
After creating the flashcards, ensure to include the Bloom's Taxonomy label for each card.

Visuals:
- For each card, determine if a visual is crucial for understanding or visualizing the answer ONLY if needed. Set needs_image to true only when a visual representation would provide significant clarity.
- If needs_image is true, provide a targeted keyword (1-3 English words) optimized for visual search.

--- BEGIN TEXT ---
${text}
--- END TEXT ---
`;

    const response = await together.chat.completions.create({
      model: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
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
          taxonomy: c.taxonomy,
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
    const summaryPrompt = `You are an expert educational writer and copyeditor, writing in clear, engaging Thai (except that any domain-specific English words or acronyms must be kept in English). Your goal is to create a concise **1-5 minute** study summary of the provided text. The output must be a self-contained chunk of **semantic** HTML (using only class attributes for styling, no inline styles).

The HTML structure should adhere to the following:

- Use an '<h1>' tag for the main title of the summary.
- Divide the content into logical sections, each marked with an '<h2>' tag.
- Present ordinary text within '<p>' tags for easy readability.
- Utilize '<ul>' and '<li>' tags to create bulleted lists for key points.
- Emphasize crucial terms and potential flashcard keywords using the '<strong>' tag.
- Use the '<em>' tag for any supplementary notes or emphasis you deem necessary.

**Crucially, the visual presentation should be enhanced through the use of CSS classes.** While you won't define the CSS itself, apply relevant and descriptive class names to the HTML elements to suggest their intended styling. Think about classes that would improve readability and organization. For example, you might use classes like 'main-title', 'section-heading', 'important-term', 'list-item', 'emphasis-note', etc.

**Do not** output any plain-text lists or Markdown. **Do not** wrap your HTML in '<html>' or '<body>' tags—only the HTML snippet itself. **Do not** include any commentary or explanatory text outside the HTML.

Aim for a visually appealing and easily scannable summary entirely in Thai (with necessary English terms).

Example of the desired output structure (including potential class names):

<h1 class="main-title">บทสรุปเรื่องหิน</h1>
<p>หินเกิดขึ้นจากการรวมตัวและแข็งตัวของแร่ธาตุต่างๆ... <strong class="important-term">หินอัคนี</strong>, <strong class="important-term">หินตะกอน</strong>, และ <strong class="important-term">หินแปร</strong>...</p>
<h2 class="section-heading">หินอัคนี</h2>
<p>เกิดจากการเย็นตัวและแข็งตัวของหินหนืด...</p>
<ul class="key-points">
  <li class="list-item"><strong>หินภูเขาไฟ</strong>: ลาวา...</li>
  <li class="list-item"><strong>หินอัคนีแทรกซ้อน</strong>: แมกมา...</li>
</ul>
<h2 class="section-heading">หินตะกอน</h2>
<p>เกิดจากการทับถมของตะกอน...</p>
<h2 class="section-heading">หินแปร</h2>
<p>เกิดจากการเปลี่ยนแปลงสภาพ...</p>
<p class="emphasis-note"><em>การแปรสภาพสัมผัส...</em></p>

BEGIN RAW TEXT
${text}
END RAW TEXT
`;

    const sumResp = await together.chat.completions.create({
      model: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
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
5. Don't make it too long, not longer than 2 paragraphs.

Flashcard Question: ${question}  
Flashcard Answer: ${answer}  

Output the explanation in Thai.
    `;

    // Call the Together API with your prompt
    const response = await together.chat.completions.create({
      model: 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 250,
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
You are an expert educator. From the input text below, generate flashcards in Thai using Bloom's Taxonomy (Remember / Understand / Apply).
For each flashcard, decide **if a visual (photo, diagram, or icon) would significantly boost understanding or that will allow the user to be able to visualize the concept in their heads.
 
- Generate a very short deck title (1-3 words) prefixed by an appropriate emoji.
- Generate a one-sentence description of the deck (in Thai, aside from any English terms).
- Generate only 3 - 6 Flashcards

Output **only** this JSON array—no commentary:
[
  { "question": "...", "answer": "...", "keyword": "...", "needs_image": false // or true },
  …
]

Rules for keyword:
- 1-3 English words or short phrase (e.g. “photosynthesis diagram”) for searching images. The the keywords you use has to be able to serach for a good representation answer of the question make sure the user or visual learners will be able to learn as good as possible like diagrams, etc. I want you to think of visual learners and their needs for the serach keyword.
- If you decided that needs_image is false, keyword can be empty or omitted.

Steps:
1) Generate Flashcards to let the user further understand the flashcard below using Bloom's Taxonomy (Remember / Understand / Apply)
2) For each, set needs_image to true **only** when a visual cue clearly maps to the concept.  
3) Provide keyword only when needs_image=true.

--- BEGIN TEXT ---
flashcard ต้นฉบับ:
Q: ${question}
A: ${answer}
--- END TEXT ---
`.trim();

    const resp = await together.chat.completions.create({
      model: 'meta-llama/Llama-4-Scout-17B-16E-Instruct',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1200,
    });

    let raw;
    try { raw = JSON.parse(resp.choices[0].message.content); }
    catch { throw new Error('LLM did not return valid JSON'); }

    if (Array.isArray(raw)) {
      // OK
    } else if (raw.cards && Array.isArray(raw.cards)) {
      raw = raw.cards;               // model used a wrapper object
    } else {
      throw new Error('LLM did not return an array');
    }

    /* ---------- 2. Enrich each card ---------- */
    const cards = await Promise.all(raw.map(hydrateCard));

    res.json({ cards });
  } catch (err) {
    console.error('related-cards error:', err);
    res.status(500).json({ error: err.message });
  }
});



module.exports = router;
