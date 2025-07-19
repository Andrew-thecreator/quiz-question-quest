// Firebase Admin SDK imports and initialization
const admin = require("firebase-admin");
const serviceAccount = JSON.parse(
  Buffer.from(process.env.FIREBASE_SERVICE_JSON, 'base64').toString()
);
const { getFirestore } = require("firebase-admin/firestore");

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = getFirestore();
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

const allowedOrigins = [
  "https://quizcast.online",
  "https://www.quizcast.online",
  "https://quiz-question-quest.vercel.app",
  "http://localhost:5173"
];

// Stripe needs raw body for webhook
app.use('/webhook', express.raw({ type: 'application/json' }));

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
  console.log("➡️  PDF upload endpoint hit");
  try {
    // Firebase Auth + Credits logic
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) return res.status(401).json({ error: 'Unauthorized: No token' });

    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
      console.log("✅ Authenticated user:", decodedToken.uid);
    } catch (error) {
      console.error('Token verification failed:', error);
      return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }

    const userId = decodedToken.uid;
    const userRef = db.collection("users").doc(userId);
    const userDoc = await userRef.get();
    console.log("📄 User doc exists:", userDoc.exists);
    const now = new Date();
    const today = now.toISOString().split('T')[0]; // YYYY-MM-DD

    let credits = 2;

    if (!userDoc.exists) {
      // New user, initialize credits
      await userRef.set({ credits: 2, lastUsed: today });
      console.log("📝 Created or updated Firestore document with credits and lastUsed");
    } else {
      const data = userDoc.data();
      if (data.unlimited === true) {
        const now = new Date();
        if (data.valid_until && new Date(data.valid_until) < now) {
          await userRef.set({ unlimited: false }, { merge: true });
          console.log("❌ Subscription expired, unlimited revoked");
        }
      }
      if (data.unlimited === true) {
        console.log("💎 Unlimited user detected — skipping credit check");
        // PDF parsing logic
        const pdfBuffer = fs.readFileSync(req.file.path);
        const data = await pdfParse(pdfBuffer);
        storedPdfText = data.text;
        return res.json({ message: 'PDF uploaded and parsed successfully.' });
      }
      if (data.lastUsed === today) {
        credits = data.credits ?? 2; // default to 2 if undefined
      } else {
        // Reset for a new day
        await userRef.set({ credits: 2, lastUsed: today }, { merge: true });
        console.log("📝 Created or updated Firestore document with credits and lastUsed");
        credits = 2;
      }
    }

    // Early return if no credits left
    if (credits <= 0) {
      return res.status(402).json({ error: "You have used all 3 free uploads for today. Please upgrade to continue." });
    }

    // Deduct 1 credit
    await userRef.set({ credits: credits - 1, lastUsed: today }, { merge: true });

    // PDF parsing logic
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
      model: "gpt-3.5-turbo",
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
      model: "gpt-3.5-turbo",
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
      model: "gpt-3.5-turbo",
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

app.get('/credits', async (req, res) => {
  try {
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) return res.status(401).json({ error: 'Unauthorized' });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const userRef = db.collection("users").doc(decoded.uid);
    const doc = await userRef.get();

    if (!doc.exists) {
      const today = new Date().toISOString().split('T')[0];
      await userRef.set({ credits: 2, lastUsed: today });
      return res.json({ credits: 2, unlimited: false });
    }

    const data = doc.data();

    const now = new Date();
    if (data.unlimited === true && data.valid_until && new Date(data.valid_until) < now) {
      await userRef.set({ unlimited: false }, { merge: true });
      console.log("❌ Subscription expired, unlimited revoked");
    }

    if (data.unlimited === true) {
      return res.json({ credits: Infinity, unlimited: true });
    }

    const today = new Date().toISOString().split('T')[0];

    if (data.lastUsed !== today) {
      await userRef.set({ credits: 2, lastUsed: today }, { merge: true });
      return res.json({ credits: 2, unlimited: false });
    }

    return res.json({ credits: data.credits ?? 2, unlimited: false });
  } catch (err) {
    console.error("Error fetching credits:", err);
    return res.status(500).json({ error: "Failed to fetch credits" });
  }
});

app.post('/upgrade', async (req, res) => {
  try {
    const idToken = req.headers.authorization?.split('Bearer ')[1];
    if (!idToken) return res.status(401).json({ error: 'Unauthorized' });

    const decoded = await admin.auth().verifyIdToken(idToken);
    const userRef = db.collection("users").doc(decoded.uid);

    const { plan } = req.body;
    if (!plan || !['monthly', 'yearly'].includes(plan)) {
      return res.status(400).json({ error: "Invalid or missing subscription plan" });
    }

    const now = new Date();
    const validUntil = new Date(now);
    if (plan === 'monthly') {
      validUntil.setMonth(validUntil.getMonth() + 1);
    } else if (plan === 'yearly') {
      validUntil.setFullYear(validUntil.getFullYear() + 1);
    }

    await userRef.set({
      unlimited: true,
      subscription: plan,
      valid_until: validUntil.toISOString()
    }, { merge: true });

    res.json({ success: true, message: `User upgraded to ${plan}.` });
  } catch (error) {
    console.error("Error upgrading user:", error);
    res.status(500).json({ error: "Failed to upgrade user." });
  }
});

app.post('/webhook', async (req, res) => {
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    console.log('🔥 SESSION COMPLETED:', session);

    const uid = session.metadata?.uid;
    if (!uid) {
      console.error('❌ No UID found in session metadata');
      return res.status(400).send('No UID provided');
    }

    try {
      await db.collection('users').doc(uid).set({
        isPro: true,
        credits: 9999,
        email: session.customer_email || null
      }, { merge: true });
      console.log('✅ Firestore updated for UID:', uid);
    } catch (err) {
      console.error('❌ Firestore update failed:', err);
    }
  } else if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    // Debug log for invoice payload
    console.log('💰 Full invoice payload:', JSON.stringify(invoice, null, 2));
    let subscriptionId = invoice.subscription;

    if (!subscriptionId) {
      try {
        const line = invoice.lines?.data?.[0];
        subscriptionId = line?.parent?.subscription_item_details?.subscription;
      } catch (err) {
        console.error('❌ Failed to extract subscription ID from fallback path');
      }
    }

    if (!subscriptionId) {
      console.error('❌ No subscription ID found in invoice or fallback');
      return res.status(400).send('No subscription ID');
    }

    try {
      // Fetch full subscription object from Stripe, expanding items.data
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['items.data']
      });

      let uid = subscription.metadata?.uid;
      if (!uid) {
        console.warn('⚠️ No UID in metadata. Attempting fallback using email:', invoice.customer_email);
        const snapshot = await db.collection('users')
          .where('email', '==', invoice.customer_email)
          .limit(1)
          .get();

        if (snapshot.empty) {
          console.error('❌ No user found with email:', invoice.customer_email);
          return res.status(400).send('No UID found via email fallback');
        }

        uid = snapshot.docs[0].id;
      }

      const plan = subscription.metadata?.plan || 'unknown';
      const periodEndUnix =
        subscription.current_period_end ||
        subscription.items?.data?.[0]?.current_period_end ||
        subscription.billing_cycle_anchor;

      if (!periodEndUnix) {
        console.error('❌ No valid period end timestamp found in subscription');
        return res.status(400).send('Missing subscription period end');
      }

      const periodEnd = new Date(periodEndUnix * 1000).toISOString();

      await db.collection('users').doc(uid).set({
        unlimited: true,
        valid_until: periodEnd,
        subscription: plan,
        email: invoice.customer_email || null
      }, { merge: true });

      console.log(`✅ Updated Firestore for UID ${uid} with plan ${plan} until ${periodEnd}`);
    } catch (err) {
      console.error('❌ Failed to update subscription info:', err);
    }
  }

  res.status(200).send('Received');
});

app.post('/create-checkout-session', async (req, res) => {
  const { plan } = req.body;
  const idToken = req.headers.authorization?.split('Bearer ')[1];

  if (!idToken || !['monthly', 'yearly'].includes(plan)) {
    return res.status(400).json({ error: "Missing token or invalid plan" });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const user = await admin.auth().getUser(decoded.uid);
    const priceId = plan === 'yearly'
      ? process.env.STRIPE_YEARLY_PRICE_ID
      : process.env.STRIPE_MONTHLY_PRICE_ID;

    const baseUrl = req.headers.origin || 'https://quizcast.online';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: user.email,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { uid: decoded.uid }, // ← Added here
      subscription_data: {
        metadata: { uid: decoded.uid, plan }
      },
      success_url: `${baseUrl}/`,
      cancel_url: `${baseUrl}/`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("🔥 Stripe checkout session error:", err);
    res.status(500).json({ error: "Failed to start checkout" });
  }
});

app.post('/create-portal-session', async (req, res) => {
  const idToken = req.headers.authorization?.split('Bearer ')[1];
  if (!idToken) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    const userId = decoded.uid;
    const user = await admin.auth().getUser(userId);

    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
    const customer = customers.data[0];

    if (!customer) {
      return res.status(404).json({ error: "Customer not found in Stripe" });
    }

    const returnUrl = req.headers.origin || 'https://quizcast.online';

    const session = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: returnUrl,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error('🔥 Failed to create portal session:', error);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

app.listen(3000, '0.0.0.0', () => {
  console.log('Server is running on http://0.0.0.0:3000');
});