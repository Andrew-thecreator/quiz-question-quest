const functions = require("firebase-functions");
const admin = require("firebase-admin");
const stripe = require("stripe")(functions.config().stripe.secret_key);
const cors = require("cors")({ origin: true });

admin.initializeApp();

// Callable function — for apps using Firebase SDK (not REST API)
exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
  const priceId = data.priceId;
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    payment_method_types: ["card"],
    line_items: [
      {
        price: priceId,
        quantity: 1,
      },
    ],
    success_url: "https://quiz-question-quest.vercel.app/",
    cancel_url: "https://quiz-question-quest.vercel.app/",
  });

  return {
    sessionId: session.id,
  };
});

// HTTP endpoint — for calling via fetch() from your frontend
exports.createCheckoutSessionHttp = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "subscription",
        line_items: [
          {
            price: functions.config().stripe.monthly_price_id,
            quantity: 1,
          },
        ],
        success_url: "https://quiz-question-quest.vercel.app/",
        cancel_url: "https://quiz-question-quest.vercel.app/",
      });

      res.status(200).json({ url: session.url });
    } catch (error) {
      console.error("Error creating checkout session:", error);
      res.status(500).send("Internal Server Error");
    }
  });
});
