require('dotenv').config();
// Store parsed PDF text in memory for use across endpoints
let storedPdfText = '';

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const { OpenAI } = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = express();
const upload = multer({ dest: 'uploads/' });

const allowedOrigins = ["https://quizcast.online", "https://quiz-question-quest.vercel.app"];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true
}));

app.use((req, res, next) => {
  const origin = req.get("origin");
  const referer = req.get("referer");

  console.log("Origin:", origin);
  console.log("Referer:", referer);

  if (
    (origin && !allowedOrigins.includes(origin)) ||
    (referer && !allowedOrigins.some(url => referer.startsWith(url)))
  ) {
    return res.status(403).json({ error: "Forbidden: Invalid origin" });
  }

  next();
});

app.use(express.json());

app.post('/upload', upload.single('pdf'), async (req, res) => {
  try {
    const pdfBuffer = fs.readFileSync(req.file.path);
    const data = await pdfParse(pdfBuffer);
    storedPdfText = data.text;
    res.json({ message: 'PDF uploaded and parsed successfully.' });
  } catch (error) {
    console.error('Error uploading PDF:', error);
    res.status(500).json({ error: 'Failed to parse PDF.' });
  } finally {
    if (req.file) fs.unlinkSync(req.file.path);
  }
});

app.post('/generate-podcast', async (req, res) => {
  try {
    if (!storedPdfText) return res.status(400).json({ error: 'No PDF uploaded yet.' });

    const chatCompletion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You're a professional podcast writer. Generate a podcast script from this PDF content. Generate the script in the language of the pdf"
        },
        {
          role: "user",
          content: storedPdfText.slice(0, 8000)
        }
      ]
    });

    const script = chatCompletion.choices[0].message.content;

    const audioResponse = await openai.audio.speech.create({
      model: "tts-1",
      voice: "shimmer",
      input: script
    });

    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
    fs.writeFileSync('podcast.mp3', audioBuffer);

    const base64Audio = audioBuffer.toString('base64');

    res.json({
      script,
      audio: base64Audio
    });
  } catch (error) {
    console.error('Error generating podcast:', error);
    res.status(500).json({ error: 'Failed to generate podcast.' });
  }
});

// Endpoint to generate quiz questions based on uploaded PDF
app.post('/quiz', async (req, res) => {
  try {
    if (!storedPdfText) return res.status(400).json({ error: 'No PDF uploaded yet.' });

    const quizCompletion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        {
          role: "system",
          content: "You are an educational assistant. Generate 5 unique and varied multiple-choice quiz questions from the provided content. Avoid repeating the same questions or phrasing across different requests, even if the input document is the same. Return ONLY a valid JSON array. Each object must include: 'question' (string), 'choices' (array of 4 strings), and 'answer' (one of the choices). Do not include explanations or any extra formatting."
        },
        {
          role: "user",
          content: storedPdfText.slice(0, 8000)
        }
      ]
    });

    const raw = quizCompletion.choices[0].message.content;
    const quiz = JSON.parse(raw);
    res.json({ quiz });
  } catch (error) {
    console.error('Error generating quiz:', error);
    res.status(500).json({ error: 'Failed to generate quiz.' });
  }
});

// Endpoint to answer a user question using only the PDF content
app.post('/ask', async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'Missing question' });
    if (!storedPdfText) return res.status(400).json({ error: 'No PDF uploaded yet.' });

    const answerCompletion = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "You are a helpful assistant that answers questions using ONLY the content from the uploaded PDF. If the answer isn't present, respond 'I don't know'." },
        { role: "user", content: `Document:\n${storedPdfText.slice(0, 8000)}\n\nQuestion: ${question}` }
      ]
    });

    const answer = answerCompletion.choices[0].message.content;
    res.json({ answer });
  } catch (error) {
    console.error('Error answering question:', error);
    res.status(500).json({ error: 'Failed to answer question.' });
  }
});

app.listen(3000, '0.0.0.0', () => {
  console.log('Server is running on http://0.0.0.0:3000');
});