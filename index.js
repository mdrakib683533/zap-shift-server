const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ObjectId } = require("mongodb");

dotenv.config();
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

const app = express();
const port = process.env.PORT || 5000;

// middleware
app.use(cors());
app.use(express.json());

// MongoDB connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.iyvodwl.mongodb.net/?appName=Cluster0`;

const client = new MongoClient(uri);
let parcelsCollection;
let paymentsCollection;
let trackingCollection;

async function run() {
  try {
    await client.connect();
    console.log("MongoDB connected successfully");

    const db = client.db("zapShiftDB");
    parcelsCollection = db.collection("parcels");
    paymentsCollection = db.collection("payments");
    trackingCollection = db.collection("tracking");

    // Get parcels
    app.get("/parcels", async (req, res) => {
      try {
        const { email } = req.query;

        const query = email ? { createdBy: email } : {};

        const parcels = await parcelsCollection
          .find(query)
          .sort({ createdAt: -1 })
          .toArray();

        res.send(parcels);
      } catch (error) {
        console.error("Failed to get parcels:", error);

        res.status(500).send({
          message: "Failed to get parcels",
        });
      }
    });

    // get a specific parcel by id
    app.get("/parcels/:id", async (req, res) => {
      try {
        const { id } = req.params;

        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!parcel) {
          return res.status(404).send({
            message: "Parcel not found",
          });
        }

        res.send(parcel);
      } catch (error) {
        console.error(error);

        res.status(500).send({
          message: "Failed to get parcel",
        });
      }
    });

    // Add a new parcel
    app.post("/parcels", async (req, res) => {
      try {
        const parcel = req.body;

        const result = await parcelsCollection.insertOne(parcel);

        res.send(result);
      } catch (error) {
        console.error("Failed to add parcel:", error);

        res.status(500).send({
          message: "Failed to add parcel",
        });
      }
    });

    // Delete parcel
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const { id } = req.params;

        const result = await parcelsCollection.deleteOne({
          _id: new ObjectId(id),
        });

        res.send(result);
      } catch (error) {
        console.error("Failed to delete parcel:", error);

        res.status(500).send({
          message: "Failed to delete parcel",
        });
      }
    });
  } catch (error) {
    console.error("MongoDB connection failed:", error);
  }
}

// tracking related
app.post("/tracking", async (req, res) => {
  try {
    const trackingInfo = {
      ...req.body,
      createdAt: new Date(),
    };

    const result = await trackingCollection.insertOne(trackingInfo);

    res.send({
      success: true,
      message: "Tracking update added successfully",
      trackingId: result.insertedId,
    });
  } catch (error) {
    console.error("Failed to add tracking update:", error);

    res.status(500).send({
      success: false,
      message: "Failed to add tracking update",
    });
  }
});



app.get("/payments", async (req, res) => {
  const email = req.query.email;

  const query = email ? { userEmail: email } : {};

  const result = await paymentsCollection
    .find(query)
    .sort({ paid_at: -1 })
    .toArray();

  res.send(result);
});

// POST: record payment and update parcel status
app.post("/payments", async (req, res) => {
  const { parcelId, transactionId, paymentMethod, amount, userEmail } =
    req.body;

  try {
    // Check if this payment was already saved
    const existingPayment = await paymentsCollection.findOne({
      transactionId,
    });

    if (existingPayment) {
      return res.send({
        success: true,
        message: "Payment already saved",
        paymentId: existingPayment._id,
      });
    }

    // Update parcel payment status
    const parcelResult = await parcelsCollection.updateOne(
      { _id: new ObjectId(parcelId) },
      {
        $set: {
          payment_status: "paid",
        },
      },
    );

    if (parcelResult.matchedCount === 0) {
      return res.status(404).send({
        success: false,
        message: "Parcel not found",
      });
    }

    // Save payment history
    const paymentInfo = {
      parcelId,
      userEmail,
      amount,
      paymentMethod,
      transactionId,
      payment_status: "paid",
      paid_at: new Date(),
    };

    const paymentResult = await paymentsCollection.insertOne(paymentInfo);

    res.send({
      success: true,
      message: "Payment successful and history saved",
      paymentId: paymentResult.insertedId,
    });
  } catch (error) {
    console.error("Payment save error:", error);

    res.status(500).send({
      success: false,
      message: error.message,
    });
  }
});

// payment intent
app.post("/create-payment-intent", async (req, res) => {
  const amountInCents = req.body.amountInCents;
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      // amount in cents
      amount: amountInCents,
      currency: "usd",
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

run();

// Test route
app.get("/", (req, res) => {
  res.send("Zap Shift Server is running");
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
